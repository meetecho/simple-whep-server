'use strict';

/*
 * Simple WHEP server
 *
 * Author:  Lorenzo Miniero <lorenzo@meetecho.com>
 * License: GPLv3
 *
 * Janus API stack (WebSocket)
 *
 */

/*
 * Usage:
 *
 * var WhepJanus = require("./whep-janus.js");
 * var wj = new WhepJanus(config);
 *
 */

var noop = function(){};

// Connectivity
var WebSocketClient = require('websocket').client;

// Debugging
var debug = require('debug');
var whep = {
	vdebug: debug('janus:vdebug'),
	debug: debug('janus:debug'),
	err: debug('janus:error'),
	warn: debug('janus:warn'),
	info: debug('janus:info')
};

var whepJanus = function(janusConfig) {

	let that = this;

	// We use this method to register callbacks
	this.callbacks = {};
	this.on = function(event, callback) {
		that.callbacks[event] = callback;
	}

	// Configuration is static for now: we'll make this dynamic
	this.config = {
		janus: {
			ws: janusConfig.address,
			apiSecret: janusConfig.apiSecret
		}
	};
	whep.debug("Janus:", that.config);
	// Enrich the configuration with the additional info we need
	that.config.janus.session = { id: 0 };
	that.config.janus.state = "disconnected";
	that.config.janus.transactions = {};
	// Tables
	let sessions = {};		// Not to be confused with Janus sessions
	let handles = {};		// All Janus handles (map to local sessions here)

	// Public method to check when the class object is ready
	this.isReady = function() { return that.config.janus.session && that.config.janus.session.id !== 0; };
	this.getState = function() { return that.config.janus.state; };

	// Connect to Janus via WebSockets
	this.connect = function(callback) {
		whep.info("Connecting to " + that.config.janus.ws);
		// Callbacks
		callback = (typeof callback == "function") ? callback : noop;
		let disconnectedCB = (typeof that.callbacks["disconnected"] == "function") ? that.callbacks["disconnected"] : noop;
		// Connect to Janus via WebSockets
		if(that.config.janus.state !== "disconnected" || that.config.ws) {
			whep.warn("Already connected/connecting");
			callback({ error: "Already connected/connecting" });
			return;
		}
		that.config.ws = new WebSocketClient();
		that.config.ws.on('connectFailed', function(error) {
			whep.err('Janus WebSocket Connect Error: ' + error.toString());
			cleanup();
			callback({ error: error.toString() });
			disconnectedCB();
		});
		that.config.ws.on('connect', function(connection) {
			whep.info('Janus WebSocket Client Connected');
			that.config.ws.connection = connection;
			// Register events
			connection.on('error', function(error) {
				whep.err("Janus WebSocket Connection Error: " + error.toString());
				cleanup();
				callback({ error: error.toString() });
				disconnectedCB();
			});
			connection.on('close', function() {
				whep.info('Janus WebSocket Connection Closed');
				cleanup();
				disconnectedCB();
			});
			connection.on('message', function(message) {
				if(message.type === 'utf8') {
					let json = JSON.parse(message.utf8Data);
					whep.vdebug("Received message:", json);
					let event = json["janus"];
					let transaction = json["transaction"];
					if(transaction) {
						let reportResult = that.config.janus.transactions[transaction];
						if(reportResult) {
							reportResult(json);
						}
						return;
					}
					if(event === 'hangup') {
						// Janus told us this PeerConnection is gone
						let sender = json["sender"];
						let handle = handles[sender];
						if(handle) {
							let session = sessions[handle.uuid];
							if(session && session.whepId && session.teardown && (typeof session.teardown === "function")) {
								// Notify the application layer
								session.teardown(session.uuid);
							}
						}
					}
				}
			});
			// Create the session now
			janusSend({ janus: "create" }, function(response) {
				whep.debug("Session created:", response);
				if(response["janus"] === "error") {
					whep.err("Error creating session:", response["error"]["reason"]);
					disconnect();
					return;
				}
				// Unsubscribe from this transaction as well
				delete that.config.janus.transactions[response["transaction"]];
				that.config.janus.session.id = response["data"]["id"];
				whep.info("Janus session ID is " + that.config.janus.session.id);
				// We need to send keep-alives on a regular basis
				that.config.janus.session.timer = setInterval(function() {
					// Send keep-alive
					janusSend({ janus: "keepalive", session_id: that.config.janus.session.id }, function(response) {
						// Unsubscribe from this keep-alive transaction
						delete that.config.janus.transactions[response["transaction"]];
					});
					// FIXME We should monitor it getting back or not
				}, 15000);
				// Send an "info" request to check what version of Janus we're talking
				// to, and also to make sure the VideoRoom plugin is available
				janusSend({ janus: "info" }, function(response) {
					if(response["janus"] === "error") {
						whep.err("Error retrieving server info:", response["error"]["reason"]);
						disconnect();
						return;
					}
					let found = false;
					if(response.plugins) {
						for(let plugin in response.plugins) {
							if(plugin === "janus.plugin.videoroom") {
								found = true;
								break;
							}
						}
					}
					if(!found) {
						whep.err("VideoRoom plugin not available in configured Janus instance");
						disconnect();
						return;
					}
					that.config.janus.multistream = (response.version >= 1000);
					whep.info("Janus instance version: " + response.version_string + " (" +
						(that.config.janus.multistream ? "multistream" : "legacy") + ")");
					// We're done
					that.config.janus.state = "connected";
					callback();
				});
			});
		});
		that.config.ws.connect(that.config.janus.ws, 'janus-protocol');
	};

	// Public methods for managing sessions
	this.addSession = function(details) {
		whep.debug("Adding session:", details);
		sessions[details.uuid] = {
			uuid: details.uuid,
			whepId: details.whepId,
			teardown: details.teardown
		};
	};
	this.removeSession = function(details) {
		whep.debug("Removing user:", details);
		let uuid = details.uuid;
		this.hangup({ uuid: uuid });
		delete sessions[uuid];
	};

	// Public method for subscribing to a Streaming plugin mountpoint
	this.subscribe = function(details, callback) {
		callback = (typeof callback === "function") ? callback : noop;
		whep.debug("Subscribing:", details);
		if(!details.mountpoint || !details.uuid) {
			callback({ error: "Missing mandatory attribute(s)" });
			return;
		}
		let mountpoint = details.mountpoint;
		let pin = details.pin;
		let uuid = details.uuid;
		let session = sessions[uuid];
		if(!session) {
			callback({ error: "No such session" });
			return;
		}
		if(session.handle) {
			callback({ error: "WebRTC " + uuid + " already established" });
			return;
		}
		// Create a handle to attach to specified plugin
		whep.debug("Creating handle for session " + uuid);
		let attach = {
			janus: "attach",
			session_id: that.config.janus.session.id,
			plugin: "janus.plugin.streaming"
		};
		janusSend(attach, function(response) {
			whep.debug("Attach response:", response);
			// Unsubscribe from the transaction
			delete that.config.janus.transactions[response["transaction"]];
			let event = response["janus"];
			if(event === "error") {
				whep.err("Got an error attaching to the plugin:", response["error"].reason);
				callback({ error: response["error"].reason });
				return;
			}
			// Take note of the handle ID
			let handle = response["data"]["id"];
			whep.debug("Plugin handle for session " + session + " is " + handle);
			session.handle = handle;
			handles[handle] = { uuid: uuid, mountpoint: mountpoint };
			// Do we have pending trickles?
			if(session.candidates && session.candidates.length > 0) {
				// Send a trickle candidates bunch request
				let candidates = {
					janus: "trickle",
					session_id: that.config.janus.session.id,
					handle_id: handle,
					candidates: session.candidates
				}
				janusSend(candidates, function(response) {
					// Unsubscribe from the transaction right away
					delete that.config.janus.transactions[response["transaction"]];
				});
				session.candidates = [];
			}
			// Send a request to the plugin to subscribe
			let subscribe = {
				janus: "message",
				session_id: that.config.janus.session.id,
				handle_id: handle,
				body: {
					request: "watch",
					id: mountpoint,
					pin: pin
				}
			};
			janusSend(subscribe, function(response) {
				let event = response["janus"];
				if(event === "error") {
					delete that.config.janus.transactions[response["transaction"]];
					whep.err("Got an error subscribing:", response["error"].reason);
					callback({ error: response["error"].reason });
					return;
				}
				if(event === "ack") {
					whep.debug("Got an ack to the setup for session " + uuid + ", waiting for result...");
					return;
				}
				// Get the plugin data: is this a success or an error?
				let data = response.plugindata.data;
				if(data.error) {
					// Unsubscribe from the transaction
					delete that.config.janus.transactions[response["transaction"]];
					whep.err("Got an error subscribing:", data.error);
					callback({ error: data.error });
					return;
				}
				whep.debug("Got an offer for session " + uuid + ":", data);
				if(data["reason"]) {
					// Unsubscribe from the transaction
					delete that.config.janus.transactions[response["transaction"]];
					// Notify the error
					callback({ error: data["reason"] });
				} else {
					// Unsubscribe from the transaction
					delete that.config.janus.transactions[response["transaction"]];
					// Notify the response
					let jsep = response["jsep"];
					callback(null, { jsep: jsep });
				}
			});
		});
	};
	this.finalize = function(details, callback) {
		callback = (typeof callback === "function") ? callback : noop;
		whep.debug("Finalizing:", details);
		if(!details.uuid || !details.jsep) {
			callback({ error: "Missing mandatory attribute(s)" });
			return;
		}
		let uuid = details.uuid;
		let session = sessions[uuid];
		if(!session) {
			callback({ error: "No such session" });
			return;
		}
		if(!session.handle) {
			callback({ error: "No Janus handle available for " + uuid });
			return;
		}
		if(session.answered) {
			callback({ error: "Session " + uuid + " already answered" });
			return;
		}
		session.answered = true;
		// Send a different request according to the medium we're setting up
		let start = {
			janus: "message",
			session_id: that.config.janus.session.id,
			handle_id: session.handle,
			body: {
				request: "start",
			},
			jsep: details.jsep
		};
		janusSend(start, function(response) {
			let event = response["janus"];
			if(event === "ack") {
				whep.info("Got an ack to our finalization (" + uuid + "), waiting for result...");
				return;
			}
			// Get the plugin data: is this a success or an error?
			let data = response.plugindata.data;
			if(data.error) {
				// Unsubscribe from the call transaction
				delete that.config.janus.transactions[response["transaction"]];
				whep.err("Got an error finalizing session for " + uuid + ":", data.error);
				callback({ error: data.error });
				return;
			}
			let result = data["result"];
			whep.debug("Got an answer to the " + uuid + " finalization:", result);
			if(result) {
				// Unsubscribe from the call transaction
				delete that.config.janus.transactions[response["transaction"]];
				// Notify the success
				callback();
			}
		});
	};
	this.trickle = function(details, callback) {
		callback = (typeof callback === "function") ? callback : noop;
		whep.debug("Trickling:", details);
		if(!details.candidate || !details.uuid) {
			callback({ error: "Missing mandatory attribute(s)" });
			return;
		}
		let candidate = details.candidate;
		let uuid = details.uuid;
		let session = sessions[uuid];
		if(!session) {
			callback({ error: "No such session" });
			return;
		}
		if(!session.handle) {
			// We don't have a handle yet, enqueue the trickle
			if(!session.candidates)
				session.candidates = [];
			session.candidates.push(candidate);
			return;
		}
		// Send a trickle request
		let trickle = {
			janus: "trickle",
			session_id: that.config.janus.session.id,
			handle_id: session.handle,
			candidate: candidate
		}
		janusSend(trickle, function(response) {
			// Unsubscribe from the transaction right away
			delete that.config.janus.transactions[response["transaction"]];
		});
	};
	this.hangup = function(details, callback) {
		callback = (typeof callback === "function") ? callback : noop;
		whep.debug("Stopping WebRTC session:", details);
		if(!details.uuid) {
			callback({ error: "Missing mandatory attribute(s)" });
			return;
		}
		let uuid = details.uuid;
		let session = sessions[uuid];
		if(!session) {
			callback({ error: "No such session" });
			return;
		}
		if(!session.handle) {
			callback({ error: "WebRTC session not established for " + uuid });
			return;
		}
		// Get rid of the handle now
		let handle = session.handle;
		delete handles[handle];
		session.handle = 0;
		// We hangup sending a detach request
		let hangup = {
			janus: "detach",
			session_id: that.config.janus.session.id,
			handle_id: handle
		}
		janusSend(hangup, function(response) {
			// Unsubscribe from the transaction
			delete that.config.janus.transactions[response["transaction"]];
			whep.debug("Handle detached for session " + uuid);
			callback();
		});
	};
	this.destroy = function() {
		disconnect();
	};

	// Private method to disconnect from Janus and cleanup resources
	function disconnect() {
		if(that.config.ws && that.config.ws.connection) {
			try {
				that.config.ws.connection.close();
				that.config.ws.connection = null;
			} catch(e) {
				// Don't care
			}
		}
		that.config.ws = null;
	}
	function cleanup() {
		if(that.config.janus.session && that.config.janus.session.timer)
			clearInterval(that.config.janus.session.timer);
		that.config.janus.session = { id: 0 };
		that.config.janus.transactions = {};
		sessions = {};
		disconnect();
		that.config.janus.state = "disconnected";
	}

	// Private method to send requests to Janus
	function janusSend(message, responseCallback) {
		if(that.config.ws && that.config.ws.connection) {
			let transaction = that.generateRandomString(16);
			if(responseCallback)
				that.config.janus.transactions[transaction] = responseCallback;
			message["transaction"] = transaction;
			if(that.config.janus.apiSecret !== null && that.config.janus.apiSecret !== null)
				message["apisecret"] = that.config.janus.apiSecret;
			whep.vdebug("Sending message:", message);
			that.config.ws.connection.sendUTF(JSON.stringify(message));
		}
	}

	// Helper method to create random identifiers (e.g., transaction)
	this.generateRandomString = function(len) {
		let charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let randomString = '';
		for (let i = 0; i < len; i++) {
			let randomPoz = Math.floor(Math.random() * charSet.length);
			randomString += charSet.substring(randomPoz,randomPoz+1);
		}
		return randomString;
	}

};

module.exports = whepJanus;
