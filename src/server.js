'use strict';

/*
 * Simple WHEP server
 *
 * Author:  Lorenzo Miniero <lorenzo@meetecho.com>
 * License: GPLv3
 *
 * WHEP API and endpoint management
 *
 */

// Dependencies
import express from 'express';
import cors from 'cors';
import colors from 'colors/safe.js';
import debug from 'debug';
import fs from 'fs';
import http from 'http';
import https from 'https';
import Janode from 'janode';
import StreamingPlugin from 'janode/plugins/streaming';

// Debugging
const whep = {
	debug: debug('whep:debug'),
	err: debug('whep:error'),
	warn: debug('whep:warn'),
	info: debug('whep:info')
};

// Configuration file
import config from './config.js';

// Static properties
let janus = null;
const endpoints = {};
const subscribers = {};

// Startup
(async function main() {
	// Start the backends
	try {
		// 1. Connect to Janus
		console.log(colors.yellow('[1. Janus]'));
		let level = process.env.JDEBUG;
		if(!level)
			level = 'warn';
		Janode.Logger.setLevel(level);
		await connectToJanus();
		// 2. WHEP REST API
		console.log(colors.yellow('[2. WHEP REST API]'));
		// Create REST backend via express
		let app = express();
		app.use(express.static('web'));
		setupRest(app);
		// Are we using plain HTTP or HTTPS?
		let options = null;
		let useHttps = (config.https && config.https.cert && config.https.key);
		if(useHttps) {
			options = {
				cert: fs.readFileSync(config.https.cert, 'utf8'),
				key: fs.readFileSync(config.https.key, 'utf8'),
				passphrase: config.https.passphrase
			};
		}
		let server = await (useHttps ? https : http).createServer(options, app);
		await server.listen(config.port);
		console.log('WHEP REST API listening on *:' + config.port);
		// We're up and running
		console.log(colors.cyan('WHEP server prototype started!'));
	} catch({ message }) {
		console.log(colors.red('WHEP server prototype failed to start :-('));
		console.log(message);
		process.exit(1);
	}
}());

// Janus setup
async function connectToJanus() {
	const connection = await Janode.connect({
		is_admin: false,
		address: {
			url: config.janus.address,
		},
		retry_time_secs: 3,
		max_retries: Number.MAX_VALUE
	});
	connection.once(Janode.EVENT.CONNECTION_ERROR, () => {
		whep.warn('Lost connectivity to Janus, reset the manager and try reconnecting');
		// Teardown existing endpoints
		for(const [id, endpoint] of Object.entries(endpoints)) {
			for(let uuid in endpoint.subscribers)
				delete subscribers[uuid];
			endpoint.subscribers = {};
			whep.info('[' + id + '] Terminating WHEP session');
		}
		// Reconnect
		janus = null;
		setTimeout(connectToJanus, 100);
	});
	janus = await connection.create();
	console.log('Connected to Janus:', config.janus.address);
}

// REST server setup
function setupRest(app) {
	let router = express.Router();

	// Just a helper to make sure this API is up and running
	router.get('/healthcheck', function(req, res) {
		whep.debug('/healthcheck:', req.params);
		res.sendStatus(200);
	});

	// Return a list of the configured endpoints
	router.get('/endpoints', function(req, res) {
		whep.debug('/endpoints:', req.params);
		res.setHeader('content-type', 'application/json');
		res.status(200);
		let list = [];
		for(let id in endpoints)
			list.push(endpoints[id]);
		res.send(JSON.stringify(list));
	});

	// Return a list of the subscribers
	router.get('/subscribers', function(req, res) {
		whep.debug('/subscribers:', req.params);
		res.setHeader('content-type', 'application/json');
		res.status(200);
		let list = [];
		for(const [id, subscriber] of Object.entries(subscribers)) {
			let s = {
				uuid: subscriber.uuid,
				whepId: subscriber.whepId
			}
			if(subscriber.enabling)
				s.enabling = true;
			if(subscriber.enabled)
				s.enabled = true;
			list.push(s);
		}
		res.send(JSON.stringify(list));
	});

	// Simple, non-standard, interface to create endpoints and map them to a Janus mountpoint
	router.post('/create', function(req, res) {
		whep.debug('/create:', req.body);
		let id = req.body.id;
		let mountpoint = req.body.mountpoint;
		let pin = req.body.pin;
		let label = req.body.label;
		let token = req.body.token;
		let iceServers = req.body.iceServers;
		if(!id || !mountpoint) {
			res.status(400);
			res.send('Invalid arguments');
			return;
		}
		if(endpoints[id]) {
			res.status(400);
			res.send('Endpoint already exists');
			return;
		}
		endpoints[id] = {
			id: id,
			mountpoint: mountpoint,
			pin: pin,
			label: label ? label : 'WHEP Endpoint ' + mountpoint,
			token: token,
			iceServers: iceServers,
			subscribers: {},
			enabled: false
		};
		whep.info('[' + id + '] Created new WHEP endpoint');
		// Done
		res.sendStatus(200);
	});

	// Subscribe to a WHEP endpoint
	router.post('/endpoint/:id', async function(req, res) {
		let id = req.params.id;
		let endpoint = endpoints[id];
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
		whep.debug('/endpoint/:', id);
		// If we received a payload, make sure it's an SDP
		whep.debug(req.body);
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
			if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
		}
		// Make sure Janus is up and running
		if(!janus) {
			res.status(503);
			res.send('Janus unavailable');
			return;
		}
		let uuid = generateRandomString(16);
		let subscriber = {
			uuid: uuid,
			whepId: id
		}
		subscribers[uuid] = subscriber;
		// Create a new session
		whep.info('[' + id + '] Subscribing to WHEP endpoint');
		subscriber.enabling = true;
		try {
			// Connect to the Streaming plugin
			subscriber.handle = await janus.attach(StreamingPlugin);
			subscriber.handle.on(Janode.EVENT.HANDLE_DETACHED, () => {
				// Janus notified us the session is gone, tear it down
				let subscriber = subscribers[uuid];
				if(subscriber) {
					whep.info('[' + id + '][' + uuid + '] Handle detached');
					let endpoint = endpoints[subscriber.whepId];
					if(endpoint)
						delete endpoint.subscribers[uuid];
					delete subscribers[uuid];
				}
			});
			subscriber.handle.on(Janode.EVENT.HANDLE_HANGUP, async () => {
				// Janus notified us the session is gone, tear it down
				let subscriber = subscribers[uuid];
				if(subscriber) {
					whep.info('[' + id + '][' + uuid + '] PeerConnection closed');
					await subscriber.handle.detach().catch(err => {});
					if(endpoint)
						delete endpoint.subscribers[uuid];
					delete subscribers[uuid];
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
				}
			}
			const result = await subscriber.handle.watch(details);
			subscriber.enabling = false;
			subscriber.enabled = true;
			endpoint.subscribers[uuid] = true;
			subscriber.resource = config.rest + '/resource/' + uuid;
			subscriber.latestEtag = generateRandomString(16);
			// Done
			res.setHeader('Access-Control-Expose-Headers', 'Location, Link');
			res.setHeader('Accept-Patch', 'application/trickle-ice-sdpfrag');
			res.setHeader('Location', subscriber.resource);
			res.set('ETag', '"' + subscriber.latestEtag + '"');
			let iceServers = endpoint.iceServers ? endpoint.iceServers : config.iceServers;
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
						link += ';'
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
		} catch(err) {
			whep.err('Error subscribing:', err);
			delete subscribers[uuid];
			res.status(500);
			res.send(err.error);
		}
	});

	// GET, HEAD and PUT on the endpoint must return a 405
	router.get('/endpoint/:id', function(req, res) {
		res.sendStatus(405);
	});
	router.head('/endpoint/:id', function(req, res) {
		res.sendStatus(405);
	});
	router.put('/endpoint/:id', function(req, res) {
		res.sendStatus(405);
	});

	// Patch can be used both for the SDP answer and to trickle a WHEP resource
	router.patch('/resource/:uuid', async function(req, res) {
		let uuid = req.params.uuid;
		let subscriber = subscribers[uuid];
		if(subscriber && subscriber.latestEtag)
			res.set('ETag', '"' + subscriber.latestEtag + '"');
		if(!uuid || !subscriber || !subscriber.handle) {
			res.status(404);
			res.send('Invalid resource ID');
			return;
		}
		let endpoint = endpoints[subscriber.whepId];
		if(!endpoint) {
			res.status(404);
			res.send('Invalid endpoint ID');
			return;
		}
		if(!janus) {
			res.status(503);
			res.send('Janus unavailable');
			return;
		}
		if(req.headers['content-type'] === 'application/sdp') {
			// We received an SDP answer from the client
			whep.debug('/resource[answer]/:', uuid);
			whep.debug(req.body);
			// Prepare the JSEP object
			await subscriber.handle.start({
				jsep: {
					type: 'answer',
					sdp: req.body
				}
			}).catch(err => {
				whep.err('Error finalizing subscription:', err);
				let endpoint = endpoints[subscriber.whepId];
				if(endpoint)
					delete endpoint.subscribers[uuid];
				delete subscribers[uuid];
				res.status(500);
				res.send(err.error);
			});
			whep.info('[' + uuid + '] Completed WHEP negotiation');
			res.sendStatus(204);
			return;
		}
		// If we got here, we're handling a trickle candidate
		whep.debug('/resource[trickle]/:', uuid);
		whep.debug(req.body);
		// Check the Bearer token
		let auth = req.headers['authorization'];
		if(endpoint.token) {
			if(!auth || auth.indexOf('Bearer ') < 0) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
			let authtoken = auth.split('Bearer ')[1];
			if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
		}
		// Check the latest ETag
		if(req.headers['if-match'] !== '"*"' && req.headers['if-match'] !== ('"' + endpoint.latestEtag + '"')) {
			if(config.strictETags) {
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
		// Do one more ETag check (make sure restarts have '*' as ETag, and only them)
		if(req.headers['if-match'] === '*' && config.strictETags) {
			// Only return a failure if we're configured with strict ETag checking, ignore it otherwise
			res.status(412);
			res.send('Precondition Failed');
			return;
		}
		// Trickle the candidate(s)
		if(candidates.length > 0)
			await subscriber.handle.trickle(candidates).catch(err => {});
		// We're done
		res.sendStatus(204);
	});

	// Stop subscribing to a WHEP endpoint
	router.delete('/resource/:uuid', async function(req, res) {
		let uuid = req.params.uuid;
		let subscriber = subscribers[uuid];
		if(subscriber && subscriber.latestEtag)
			res.set('ETag', '"' + subscriber.latestEtag + '"');
		if(!uuid || !subscriber) {
			res.status(404);
			res.send('Invalid resource ID');
			return;
		}
		let endpoint = endpoints[subscriber.whepId];
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
			if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
		}
		whep.debug('/resource[delete]/:', uuid);
		// Get rid of the Janus subscriber
		if(janus && subscriber.handle)
			await subscriber.handle.detach().catch(err => {});
		delete endpoint.subscribers[uuid];
		delete subscribers[uuid];
		whep.info('[' + uuid + '] Terminating WHEP session');
		// Done
		res.sendStatus(200);
	});

	// GET, HEAD, POST and PUT on the resource must return a 405
	router.get('/resource/:id', function(req, res) {
		res.sendStatus(405);
	});
	router.head('/resource/:id', function(req, res) {
		res.sendStatus(405);
	});
	router.post('/resource/:id', function(req, res) {
		res.sendStatus(405);
	});
	router.put('/resource/:id', function(req, res) {
		res.sendStatus(405);
	});

	// Simple, non-standard, interface to destroy existing endpoints
	router.delete('/endpoint/:id', function(req, res) {
		let id = req.params.id;
		let endpoint = endpoints[id];
		if(!id || !endpoint) {
			res.status(404);
			res.send('Invalid resource ID');
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
			if(!authtoken || authtoken.length === 0 || authtoken !== endpoint.token) {
				res.status(403);
				res.send('Unauthorized');
				return;
			}
		}
		whep.debug('/endpoint[destroy]/:', id);
		// Get rid of the Janus subscribers, if there's any
		if(janus) {
			for(let uuid in endpoint.subscribers) {
				janus.removeSession({ uuid: uuid });
				delete endpoint.subscribers[uuid];
				delete subscribers[uuid];
			}
		}
		delete endpoints[id];
		whep.info('[' + id + '] Destroyed WHEP endpoint');
		// Done
		res.sendStatus(200);
	});

	// Setup CORS
	app.use(cors({ preflightContinue: true }));

	// Initialize the REST API
	app.use(express.json());
	app.use(express.text({ type: 'application/sdp' }));
	app.use(express.text({ type: 'application/trickle-ice-sdpfrag' }));
	app.use(config.rest, router);
}

// Helper method to create random identifiers (e.g., transaction)
function generateRandomString(len) {
	let charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let randomString = '';
	for(let i=0; i<len; i++) {
		let randomPoz = Math.floor(Math.random() * charSet.length);
		randomString += charSet.substring(randomPoz,randomPoz+1);
	}
	return randomString;
}
