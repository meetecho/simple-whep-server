'use strict';

/*
 * Simple WHEP server
 *
 * Author:  Lorenzo Miniero <lorenzo@meetecho.com>
 * License: ISC
 *
 * WHEP API and endpoint management
 *
 */

// Dependencies
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import http from 'http';
import https from 'https';
import Janode from 'janode';
import StreamingPlugin from 'janode/plugins/streaming';
import { EventEmitter } from 'events';

// WHEP server class
class JanusWhepServer extends EventEmitter {

	// Constructor
	constructor({ janus, rest, allowTrickle = true, strictETags = false, iceServers = [], debug }) {
		super();
		// Parse configuration
		if(!janus || typeof janus !== 'object')
			throw new Error('Invalid configuration, missing parameter "janus" or not an object');
		if(!janus.address)
			throw new Error('Invalid configuration, missing parameter "address" in "janus"');
		if(!rest || typeof rest !== 'object')
			throw new Error('Invalid configuration, missing parameter "rest" or not an object');
		if(!rest.basePath)
			throw new Error('Invalid configuration, missing parameter "basePath" in "rest"');
		if(!rest.port && !rest.app)
			throw new Error('Invalid configuration, at least one of "port" and "app" should be set in "rest"');
		const debugLevels = [ 'err', 'warn', 'info', 'verb', 'debug' ];
		if(debug && debugLevels.indexOf(debug) === -1)
			throw new Error('Invalid configuration, unsupported "debug" level');
		this.config = {
			janus: {
				address: janus.address
			},
			rest: {
				port: rest.port,
				basePath: rest.basePath,
				app: rest.app
			},
			allowTrickle: (allowTrickle === true),
			strictETags: (strictETags === true),
			iceServers: Array.isArray(iceServers) ? iceServers : [iceServers]
		};

		// Resources
		this.janus = null;
		this.endpoints = new Map();
		this.subscribers = new Map();
		this.logger = new JanusWhepLogger({ prefix: '[WHEP] ', level: debug ? debugLevels.indexOf(debug) : 2 });
	}

	async start() {
		if(this.started)
			throw new Error('WHEP server already started');
		// Connect to Janus
		await this._connectToJanus();
		// WHEP REST API
		if(!this.config.rest.app) {
			// Spawn a new app and server
			this.logger.verb('Spawning new Express app');
			let app = express();
			this._setupRest(app);
			let options = null;
			let useHttps = (this.config.rest.https && this.config.rest.https.cert && this.config.rest.https.key);
			if(useHttps) {
				options = {
					cert: fs.readFileSync(this.config.rest.https.cert, 'utf8'),
					key: fs.readFileSync(this.config.rest.https.key, 'utf8'),
					passphrase: this.config.rest.https.passphrase
				};
			}
			this.server = await (useHttps ? https : http).createServer(options, app);
			await this.server.listen(this.config.rest.port);
		} else {
			// A server already exists, only add our endpoints to its router
			this.logger.verb('Reusing existing Express app');
			this._setupRest(this.config.rest.app);
		}
		// We're up and running
		this.logger.info('WHEP server started');
		this.started = true;
		return this;
	}

	async destroy() {
		if(!this.started)
			throw new Error('WHEP server not started');
		if(this.janus)
			await this.janus.close();
		if(this.server)
			this.server.close();
	}

	generateRandomString(len) {
		const charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let randomString = '';
		for(let i=0; i<len; i++) {
			let randomPoz = Math.floor(Math.random() * charSet.length);
			randomString += charSet.substring(randomPoz,randomPoz+1);
		}
		return randomString;
	}

	createEndpoint({ id, mountpoint, pin, label, token, iceServers }) {
		if(!id || !mountpoint)
			throw new Error('Invalid arguments');
		if(this.endpoints.has(id))
			throw new Error('Endpoint already exists');
		let endpoint = new JanusWhepEndpoint({
			id: id,
			mountpoint: mountpoint,
			pin: pin,
			label: label,
			token: token,
			iceServers: iceServers
		});
		this.logger.info('[' + id + '] Created new WHEP endpoint');
		this.endpoints.set(id, endpoint);
		return endpoint;
	}

	listEndpoints() {
		let list = [];
		this.endpoints.forEach(function(endpoint, id) {
			list.push({ id: id, subscribers: endpoint.countSubscribers() });
		});
		return list;
	}

	getEndpoint({ id }) {
		return this.endpoints.get(id);
	}

	async destroyEndpoint({ id }) {
		let endpoint = this.endpoints.get(id);
		if(!id || !endpoint)
			throw new Error('Invalid endpoint ID');
		// Get rid of the Janus subscribers, if there's any
		endpoint.subscribers.forEach(async function(_val, uuid) {
			let subscriber = this.subscribers.get(uuid);
			if(!subscriber)
				return;
			if(this.janus && subscriber.handle)
				await subscriber.handle.detach().catch(_err => {});
			this.subscribers.delete(uuid);
		}, this);
		this.endpoints.delete(id);
		this.logger.info('[' + id + '] Destroyed WHEP endpoint');
	}

	countSubscribers() {
		console.log(this.subscribers);
		return this.subscribers.size;
	}

	listSubscribers() {
		let list = [];
		this.subscribers.forEach(function(subscriber, uuid) {
			list.push({ endpoint: subscriber.whepId, uuid: uuid });
		});
		return list;

	}

	// Janus setup
	async _connectToJanus() {
		const connection = await Janode.connect({
			is_admin: false,
			address: {
				url: this.config.janus.address,
			},
			retry_time_secs: 3,
			max_retries: Number.MAX_VALUE
		});
		connection.once(Janode.EVENT.CONNECTION_ERROR, () => {
			this.logger.warn('Lost connectivity to Janus, reset the manager and try reconnecting');
			// Teardown existing endpoints
			this.endpoints.forEach(function(endpoint, id) {
				endpoint.subscribers.forEach(async function(_val, uuid) {
					let subscriber = this.subscribers.get(uuid);
					if(!subscriber)
						return;
					if(subscriber.handle) {
						endpoint.emit('subscriber-gone');
						this.emit('subscriber-gone', id);
					}
				}, this);
				endpoint.subscribers.clear();
				this.logger.info('[' + id + '] Terminating WHEP subscriber sessions');
				endpoint.emit('janus-disconnected');
			}, this);
			this.subscribers.clear();
			this.emit('janus-disconnected');
			// Reconnect
			this.janus = null;
			setTimeout(this._connectToJanus.bind(this), 1);
		});
		this.janus = await connection.create();
		this.logger.info('Connected to Janus:', this.config.janus.address);
		if(this.started)
			this.emit('janus-reconnected');
	}

	// REST server setup
	_setupRest(app) {
		const router = express.Router();

		// Just a helper to make sure this API is up and running
		router.get('/healthcheck', (_req, res) => {
			this.logger.debug('/healthcheck');
			res.sendStatus(200);
		});

		// Subscribe to a WHEP endpoint
		router.post('/endpoint/:id', async (req, res) => {
			let id = req.params.id;
			let endpoint = this.endpoints.get(id);
			if(!id || !endpoint) {
				res.status(404);
				res.send('Invalid endpoint ID');
				return;
			}
			if(endpoint.enabled) {
				res.status(403);
				res.send('Endpoint ID already in use');
				return;
			}
			this.logger.verb('/endpoint/:', id);
			// If we received a payload, make sure it's an SDP
			this.logger.debug(req.body);
			let offer = null;
			if(req.headers['content-type']) {
				if(req.headers['content-type'] !== 'application/sdp' || req.body.indexOf('v=0') < 0) {
					res.status(406);
					res.send('Unsupported content type');
					return;
				}
				offer = req.body;
			}
			// Check the Bearer token
			let auth = req.headers['authorization'];
			if(endpoint.token) {
				if(!auth || auth.indexOf('Bearer ') < 0) {
					res.status(403);
					res.send('Unauthorized');
					return;
				}
				let authtoken = auth.split('Bearer ')[1];
				if(typeof endpoint.token === 'function') {
					if(!endpoint.token(authtoken)) {
						res.status(403);
						res.send('Unauthorized');
						return;
					}
				} else if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
					res.status(403);
					res.send('Unauthorized');
					return;
				}
			}
			// Make sure Janus is up and running
			if(!this.janus) {
				res.status(503);
				res.send('Janus unavailable');
				return;
			}
			let uuid = this.generateRandomString(16);
			let subscriber = {
				uuid: uuid,
				whepId: id
			};
			this.subscribers.set(uuid, subscriber);
			// Create a new session
			this.logger.info('[' + id + '] Subscribing to WHEP endpoint');
			subscriber.enabling = true;
			try {
				// Connect to the Streaming plugin
				subscriber.handle = await this.janus.attach(StreamingPlugin);
				subscriber.handle.on(Janode.EVENT.HANDLE_DETACHED, () => {
					// Janus notified us the session is gone, tear it down
					let subscriber = this.subscribers.get(uuid);
					if(subscriber) {
						this.logger.info('[' + id + '][' + uuid + '] Handle detached');
						let endpoint = this.endpoints.get(subscriber.whepId);
						if(endpoint)
							endpoint.subscribers.delete(uuid);
						this.subscribers.delete(uuid);
					}
				});
				subscriber.handle.on(Janode.EVENT.HANDLE_HANGUP, async () => {
					// Janus notified us the session is gone, tear it down
					let subscriber = this.subscribers.get(uuid);
					if(subscriber) {
						this.logger.info('[' + id + '][' + uuid + '] PeerConnection closed');
						await subscriber.handle.detach().catch(_err => {});
						if(endpoint) {
							endpoint.subscribers.delete(uuid);
							endpoint.emit('subscriber-gone');
						}
						this.emit('subscriber-gone', id);
						this.subscribers.delete(uuid);
					}
				});
				let details = {
					id: endpoint.mountpoint,
					pin: endpoint.pin
				};
				if(offer) {
					// Client offer (we still support both modes)
					details.jsep = {
						type: 'offer',
						sdp: offer
					};
				}
				const result = await subscriber.handle.watch(details);
				subscriber.enabling = false;
				subscriber.enabled = true;
				endpoint.subscribers.set(uuid, true);
				subscriber.resource = this.config.rest.basePath + '/resource/' + uuid;
				subscriber.latestEtag = this.generateRandomString(16);
				if(offer) {
					subscriber.sdpOffer = offer;
					subscriber.ice = {
						ufrag: subscriber.sdpOffer.match(/a=ice-ufrag:(.*)\r\n/)[1],
						pwd: subscriber.sdpOffer.match(/a=ice-pwd:(.*)\r\n/)[1]
					};
				}
				// Done
				res.setHeader('Access-Control-Expose-Headers', 'Location, Link');
				res.setHeader('Accept-Patch', 'application/trickle-ice-sdpfrag');
				res.setHeader('Location', subscriber.resource);
				res.set('ETag', '"' + subscriber.latestEtag + '"');
				let iceServers = endpoint.iceServers ? endpoint.iceServers : this.config.iceServers;
				if(iceServers && iceServers.length > 0) {
					// Add a Link header for each static ICE server
					let links = [];
					for(let server of iceServers) {
						if(!server.uri || (server.uri.indexOf('stun:') !== 0 &&
								server.uri.indexOf('turn:') !== 0 &&
								server.uri.indexOf('turns:') !== 0))
							continue;
						let link = '<' + server.uri + '>; rel="ice-server"';
						if(server.username && server.credential) {
							link += ';';
							link += ' username="' + server.username + '";' +
								' credential="' + server.credential + '";' +
								' credential-type="password"';
						}
						links.push(link);
					}
					res.setHeader('Link', links);
				}
				res.writeHeader(201, { 'Content-Type': 'application/sdp' });
				res.write(result.jsep.sdp);
				res.end();
				endpoint.emit('new-subscriber');
				this.emit('new-subscriber', id);
			} catch(err) {
				this.logger.err('Error subscribing:', err);
				this.subscribers.delete(uuid);
				res.status(500);
				res.send(err.error);
			}
		});

		// GET, HEAD and PUT on the endpoint must return a 405
		router.get('/endpoint/:id', (_req, res) => {
			res.sendStatus(405);
		});
		router.head('/endpoint/:id', (_req, res) => {
			res.sendStatus(405);
		});
		router.put('/endpoint/:id', (_req, res) => {
			res.sendStatus(405);
		});

		// Patch can be used both for the SDP answer and to trickle a WHEP resource
		router.patch('/resource/:uuid', async (req, res) => {
			let uuid = req.params.uuid;
			let subscriber = this.subscribers.get(uuid);
			if(subscriber && subscriber.latestEtag)
				res.set('ETag', '"' + subscriber.latestEtag + '"');
			if(!uuid || !subscriber || !subscriber.handle) {
				res.status(404);
				res.send('Invalid resource ID');
				return;
			}
			let endpoint = this.endpoints.get(subscriber.whepId);
			if(!endpoint) {
				res.status(404);
				res.send('Invalid endpoint ID');
				return;
			}
			if(!this.janus) {
				res.status(503);
				res.send('Janus unavailable');
				return;
			}
			if(req.headers['content-type'] === 'application/sdp') {
				// We received an SDP answer from the client
				this.logger.verb('/resource[answer]/:', uuid);
				this.logger.debug(req.body);
				// Prepare the JSEP object
				await subscriber.handle.start({
					jsep: {
						type: 'answer',
						sdp: req.body
					}
				}).catch(err => {
					this.logger.err('Error finalizing subscription:', err);
					let endpoint = this.endpoints.get(subscriber.whepId);
					if(endpoint)
						endpoint.subscribers.delete(uuid);
					this.subscribers.delete(uuid);
					res.status(500);
					res.send(err.error);
				});
				this.logger.info('[' + uuid + '] Completed WHEP negotiation');
				res.sendStatus(204);
				return;
			}
			// If we got here, we're handling a trickle candidate
			this.logger.verb('/resource[trickle]/:', uuid);
			this.logger.debug(req.body);
			// Check the Bearer token
			let auth = req.headers['authorization'];
			if(endpoint.token) {
				if(!auth || auth.indexOf('Bearer ') < 0) {
					res.status(403);
					res.send('Unauthorized');
					return;
				}
				let authtoken = auth.split('Bearer ')[1];
				if(typeof endpoint.token === 'function') {
					if(!endpoint.token(authtoken)) {
						res.status(403);
						res.send('Unauthorized');
						return;
					}
				} else if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
					res.status(403);
					res.send('Unauthorized');
					return;
				}
			}
			// Check the latest ETag
			if(req.headers['if-match'] !== '"*"' && req.headers['if-match'] !== ('"' + endpoint.latestEtag + '"')) {
				if(this.config.strictETags) {
					// Only return a failure if we're configured with strict ETag checking, ignore it otherwise
					res.status(412);
					res.send('Precondition Failed');
					return;
				}
			}
			// Make sure we received a trickle candidate
			if(req.headers['content-type'] !== 'application/trickle-ice-sdpfrag') {
				res.status(406);
				res.send('Unsupported content type');
				return;
			}
			// Parse the RFC 8840 payload
			let fragment = req.body;
			let lines = fragment.split(/\r?\n/);
			let iceUfrag = null, icePwd = null, restart = false;
			let candidates = [];
			for(let line of lines) {
				if(line.indexOf('a=ice-ufrag:') === 0) {
					iceUfrag = line.split('a=ice-ufrag:')[1];
				} else if(line.indexOf('a=ice-pwd:') === 0) {
					icePwd = line.split('a=ice-pwd:')[1];
				} else if(line.indexOf('a=candidate:') === 0) {
					let candidate = {
						sdpMLineIndex: 0,
						candidate: line.split('a=')[1]
					};
					candidates.push(candidate);
				} else if(line.indexOf('a=end-of-candidates') === 0) {
					// Signal there won't be any more candidates
					candidates.push({ completed: true });
				}
			}
			// Check if there's a restart involved
			if(iceUfrag && icePwd && subscriber.ice && (iceUfrag !== subscriber.ice.ufrag || icePwd !== subscriber.ice.pwd)) {
				// We need to restart
				restart = true;
			}
			// Do one more ETag check (make sure restarts have '*' as ETag, and only them)
			if(req.headers['if-match'] === '*' && this.config.strictETags) {
				// Only return a failure if we're configured with strict ETag checking, ignore it otherwise
				res.status(412);
				res.send('Precondition Failed');
				return;
			}
			try {
				if(!restart) {
					// Trickle the candidate(s)
					if(candidates.length > 0)
						await subscriber.handle.trickle(candidates);
					// We're done
					res.sendStatus(204);
					return;
				}
				// TODO Restarts not supported yet, throw an error
				throw new Error('Restarts not supported yet');
			} catch(err) {
				this.logger.err('Error patching:', err);
				res.status(500);
				res.send(err.error);
			}
		});

		// Stop subscribing to a WHEP endpoint
		router.delete('/resource/:uuid', async (req, res) => {
			let uuid = req.params.uuid;
			let subscriber = this.subscribers.get(uuid);
			if(subscriber && subscriber.latestEtag)
				res.set('ETag', '"' + subscriber.latestEtag + '"');
			if(!uuid || !subscriber) {
				res.status(404);
				res.send('Invalid resource ID');
				return;
			}
			let endpoint = this.endpoints.get(subscriber.whepId);
			if(!endpoint) {
				res.status(404);
				res.send('Invalid endpoint ID');
				return;
			}
			// Check the Bearer token
			let auth = req.headers['authorization'];
			if(endpoint.token) {
				if(!auth || auth.indexOf('Bearer ') < 0) {
					res.status(403);
					res.send('Unauthorized');
					return;
				}
				let authtoken = auth.split('Bearer ')[1];
				if(typeof endpoint.token === 'function') {
					if(!endpoint.token(authtoken)) {
						res.status(403);
						res.send('Unauthorized');
						return;
					}
				} else if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
					res.status(403);
					res.send('Unauthorized');
					return;
				}
			}
			this.logger.verb('/resource[delete]/:', uuid);
			// Get rid of the Janus subscriber
			if(this.janus && subscriber.handle)
				await subscriber.handle.detach().catch(_err => {});
			endpoint.subscribers.delete(uuid);
			this.subscribers.delete(uuid);
			this.logger.info('[' + uuid + '] Terminating WHEP session');
			endpoint.emit('subscriber-gone');
			this.emit('subscriber-gone', endpoint.id);
			// Done
			res.sendStatus(200);
		});

		// GET, HEAD, POST and PUT on the resource must return a 405
		router.get('/resource/:id', (_req, res) => {
			res.sendStatus(405);
		});
		router.head('/resource/:id', (_req, res) => {
			res.sendStatus(405);
		});
		router.post('/resource/:id', (_req, res) => {
			res.sendStatus(405);
		});
		router.put('/resource/:id', (_req, res) => {
			res.sendStatus(405);
		});

		// Setup CORS
		app.use(cors({ preflightContinue: true }));

		// Initialize the REST API
		app.use(express.json());
		app.use(express.text({ type: 'application/sdp' }));
		app.use(express.text({ type: 'application/trickle-ice-sdpfrag' }));
		app.use(this.config.rest.basePath, router);
	}
}

// WHEP endpoint class
class JanusWhepEndpoint extends EventEmitter {
	constructor({ id, mountpoint, pin, label, token, iceServers }) {
		super();
		this.id = id;
		this.mountpoint = mountpoint;
		this.pin = pin;
		this.label = label;
		this.token = token;
		this.iceServers = iceServers;
		// Resources
		this.subscribers = new Map();
	}

	countSubscribers() {
		return this.subscribers.size;
	}

	listSubscribers() {
		let list = [];
		this.subscribers.forEach(function(_val, uuid) {
			list.push({ uuid: uuid });
		});
		return list;

	}
}

// Logger class
class JanusWhepLogger {
	constructor({ prefix, level }) {
		this.prefix = prefix;
		this.debugLevel = level;
	}

	err() {
		if(this.debugLevel < 0)
			return;
		let args = Array.prototype.slice.call(arguments);
		args.unshift(this.prefix + '[err]');
		console.log.apply(console, args);
	}

	warn() {
		if(this.debugLevel < 1)
			return;
		let args = Array.prototype.slice.call(arguments);
		args.unshift(this.prefix + '[warn]');
		console.log.apply(console, args);
	}

	info() {
		if(this.debugLevel < 2)
			return;
		let args = Array.prototype.slice.call(arguments);
		args.unshift(this.prefix + '[info]');
		console.log.apply(console, args);
	}

	verb() {
		if(this.debugLevel < 3)
			return;
		let args = Array.prototype.slice.call(arguments);
		args.unshift(this.prefix + '[verb]');
		console.log.apply(console, args);
	}

	debug() {
		if(this.debugLevel < 4)
			return;
		let args = Array.prototype.slice.call(arguments);
		args.unshift(this.prefix + '[debug]');
		console.log.apply(console, args);
	}
}

// Exports
export {
	JanusWhepServer,
	JanusWhepEndpoint
};
