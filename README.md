Simple WHEP Server
==================

This is a Node.js library implementation of a [WHEP server](https://datatracker.ietf.org/doc/draft-ietf-wish-whep/), developed by [Meetecho](https://www.meetecho.com), using the [Janus WebRTC Server](https://github.com/meetecho/janus-gateway/) as a WebRTC server backend and [Janode](https://github.com/meetecho/janode/) as its Janus stack. While it was initially conceived to be used mostly for testing with [Simple WHEP Client](https://github.com/meetecho/simple-whep-client) (based on [GStreamer's webrtcbin](https://gstreamer.freedesktop.org/documentation/webrtc/index.html)), as a standard WHEP implementation it's supposed to interoperate just as well with other WHEP implementations.

The library is available on [npm](https://npm.io/package/janus-whep-server) and the source code is on [Github](https://github.com/meetecho/simple-whep-server/).

> Note: this is an implementation of WHEP (WebRTC-HTTP egress protocol), **NOT** WHIP (WebRTC-HTTP ingestion protocol). If you're looking for a WHIP server to handle media ingestion, check the [Simple WHIP Server](https://github.com/meetecho/simple-whip-server) library instead. The two libraries can be used together in the same application, if you want to serve both protocols at the same time.

# Example of usage

The repo comes with a [few examples](https://github.com/meetecho/simple-whep-server/tree/master/examples) that show how you can create a new WHEP server.

You create a new server this way:

```js
const server = new JanusWhepServer(config);
await server.start();
```

where `config` is an object that may contain the following properties:

```
{
	janus: {
		address: '<Janus backend (Janode supported transports)>'
	},
	rest: {
		app: <existing Express application to add the WHEP server to, if reusing an existing REST server>
		port: <port to bind the WHEP server to, in case a new REST server is to be created>,
		basePath: '<base path to use for all WHEP endpoints, e.g., /whep>',
		https: {
			// cert, key, passphrase; in case an HTTPS server is to be created
		}
	},
	allowTrickle: <whether trickle should be allowed; true by default>,
	strictETags: <whether to be strict when checking ETags in HTTP PATCH; false by default>,
	iceServers: [
		// list of ICE servers to send back in Link headers by default, e.g.
		//	{ uri: 'stun:stun.example.net' },
		//	{ uri: 'turn:turn.example.net?transport=udp', username: 'user', credential: 'password' },
	]
}
```

The following snippet creates a WHEP server that will spawn its own REST backend on port `7090`:

```js
const server = new JanusWhepServer({
	janus: {
		address: 'ws://localhost:8188'
	},
	rest: {
		port: 7090,
		basePath: '/whep'
	}
});
```

The following snippet reuses an existing Express app contest for the WHEP server:

```js
const server = new JanusWhepServer({
	janus: {
		address: 'ws://localhost:8188'
	},
	rest: {
		app: myApp,
		basePath: '/whep'
	}
});
```

The `JanusWhepServer` exposes a few methods to manage endpoints that should be served by the WHEP server. This creates a new endpoint:

```js
const endpoint = server.createEndpoint({ id: 'test', mountpoint: 1, token: 'verysecret' });
```

which returns a `JanusWhepEndpoint` instance. You can also retrieve the same instance later on with a call to `getEndpoint(id)`, should you need it.

The object to pass when creating a new endpoint must refer to the following structure:

```
{
	id: "<unique ID of the endpoint to create>",
	mountpoint: <Streaming mountpoint ID to subscribe to>,
	pin: <Streaming mountpoint pin, if required to subscribe (optional)>,
	label: <Label to show when subscribing (optional, only relevant in the demo)>,
	token: "<token to require via Bearer authorization when using WHIP: can be either a string, or a callback function to validate the provided token (optional)>,
	iceServers: [ array of STUN/TURN servers to return via Link headers (optional, overrides global ones) ]
}
```

Subscribing to the WHEP endpoint via WebRTC can be done by sending either an SDP offer or (non-standard approach) an empty request to the created `/endpoint/<id>` endpoint via HTTP POST, which will interact with Janus on your behalf. Depending on what you sent, if successful, it will return an SDP answer or offer back in the 200 OK, plus an address for the allocated resource; if you sent an empty request initially, to complete the negotiation you'll have to send the SDP answer to the resource URL via PATCH. If you're using [Simple WHEP Client](https://github.com/meetecho/simple-whep-client) to test, the full HTTP path to the endpoint is all you need to provide as the WHEP url. Notice that, to be able to send an offer to the WHP endpoint you'll need to use at least the `1.1.4` version of Janus.

As per the specification, the response to the subscribe request will contain a `Location` header which points to the resource to use to refer to the stream. In this prototype implementation, the resource is handled by the same server instance, and is currently generated automatically as a `<basePath>/resource/<uuid>` endpoint (returned as a relative path in the header), where `uuid` is randomly generated and unique for each subscriber. That's the address used for interacting with the session, i.e., for tricking candidates, restarting ICE, and tearing down the session. The server is configured to automatically allow trickle candidates to be sent via HTTP PATCH to the `<basePath>/resource/<uuid>` endpoint: if you'd like the server to not allow trickle candidates instead (e.g., to test if your client handles a failure gracefully), you can disable them when creating the server via `allowTrickle`. ICE restarts are currently not supported. Finally, that's also the address you'll need to send the HTTP DELETE request to, in case you want to signal the intention to tear down the WebRTC PeerConnection.

Notice that a DELETE to the resource endpoint will only tear down the PeerConnection, but will preserve the endpoint, meaning new WHEP subscriptions on the same Janus mountpoint can still be created: to permanently destroy an existing endpoint, you need to destroy it via `destroyEndpoint`:

```js
server.destroyEndpoint({ id: 'test' });
```

This returns a list of existing endpoints the WHIP server is aware of:

```js
const list = server.listEndpoints();
```

Notice that the array will contain a list of objects only including the `id` and a `count` of the current subscribers to that endpoint. If you want more details on a specific endpoint (e.g., to access the endpoint instance and update the event emitter configuration), use `getEndpoint(id)` instead.

Both `JanusWhepServer` and `JanusWhepEndpoint` have a method called `listSubscribers()`, which returns the list of subscribers (to all endpoints in the first case, and to the specific endpoint in the second).

Both `JanusWhepServer` and `JanusWhepEndpoint` are also event emitters. At the time of writing, the supported events are:

* `janus-disconnected`
* `janus-reconnected`
* `new-subscriber`
* `subscriber-gone`

Check the demos for an example, which includes a basic web-based WebRTC WHEP player.
