import express from 'express';
import http from 'http';
import JanusWhepServer from '../../../src/whep.js';

(async function main() {
	console.log('Example: WHEP server using pre-existing REST backend');
	let server = null;

	// Create an HTTP server and bind to port 7090
	let myApp = express();
	myApp.get('/endpoints', async (_req, res) => {
		res.setHeader('content-type', 'application/json');
		res.status(200);
		res.send(JSON.stringify(server.listEndpoints()));
	});
	myApp.get('/subscribers', async (_req, res) => {
		res.setHeader('content-type', 'application/json');
		res.status(200);
		res.send(JSON.stringify(server.listSubscribers()));
	});
	myApp.use(express.static('../web'));
	http.createServer({}, myApp).listen(7090);

	// Create a WHEP server, and add it with base path /whep to the server above
	server = await JanusWhepServer.create({
		janus: {
			address: 'ws://localhost:8188'
		},
		rest: {
			app: myApp,
			basePath: '/whep'
		}
	});
	// Add a couple of global event handlers
	server.on('janus-disconnected', () => {
		console.log('WHEP server lost connection to Janus');
	});
	server.on('janus-reconnected', () => {
		console.log('WHEP server reconnected to Janus');
	});

	// Create a test endpoint using a callback function to validate the token
	let endpoint = server.createEndpoint({ id: 'abc123', mountpoint: 1, token: function(authtoken) {
		return authtoken === 'verysecret';
	}});
	endpoint.on('new-subscriber', function() {
		console.log(this.id + ': Endpoint has a new subscriber');
	});
	endpoint.on('subscriber-gone', function() {
		console.log(this.id + ': Endpoint subscriber left');
	});
}());
