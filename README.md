Simple WHEP Server
==================

This is prototype implementation of a [WHEP server](https://datatracker.ietf.org/doc/draft-ietf-wish-whep/), developed by [Meetecho](https://www.meetecho.com), using the [Janus WebRTC Server](https://github.com/meetecho/janus-gateway/) as a WebRTC server backend. While it was initially conceived to be used mostly for testing with [Simple WHEP Client](https://github.com/meetecho/simple-whep-client) (based on [GStreamer's webrtcbin](https://gstreamer.freedesktop.org/documentation/webrtc/index.html)), as a standard WHEP implementation it's supposed to interoperate just as well with other WHEP implementations (check [this presentation](https://github.com/IETF-Hackathon/ietf112-project-presentations/blob/main/ietf112-hackathon-whep.pdf) for some interoperability considerations).

> Note: this is an implementation of WHEP (WebRTC-HTTP egress protocol), **NOT** WHIP (WebRTC-HTTP ingestion protocol). If you're looking for a WHIP server to handle media ingestion, check [Simple WHIP Server](https://github.com/meetecho/simple-whip-server) instead.

# Installation

The server requires [Node.js](https://nodejs.org/) to run. In theory any version should work, even though I've used v12.x locally.

To install the dependencies, run:

	npm run build

# Configuration

The configuration file for the server can be found under `src/config.js`. The defaults should work fine, but in case you want to tweak anything, each property is commented so it should be easy to figure out how to modify it.

# Starting

You can start the server using the following command:

	npm start

which will use a limited amount of debugging. In case you're interested in a more verbose instance, you can use this command instead:

	npm run start-debug

# Testing

When started, the server will expose a REST interface implementing the WHEP API. Assuming the default values are used, a local instance of the server would be reachable at this base address:

	http://localhost:7090/whep

Notice that, even though WHEP is a companion protocol to WHIP, and so can be used to consume WHIP resources, the relationship between the two is not automated (at least not in this implementation), meaning that it's up to you to set up a WHEP endpoint before or after a WHIP endpoint has been successfully established. Considering Janus is used as a backend, before a WHEP endpoint can be negotiated, it needs to be created and mapped to a Janus resource. This can be done sending an HTTP POST to the `/create` endpoint of the REST API, with a JSON payload formatted like this:

```
{
	"id": "<unique ID of the endpoint to create>",
	"mountpoint": <Streaming mountpoint ID to subscribe to>,
	"pin": <Streaming mountpoint pin, if required to subscribe (optional)>,
	"label": <Label to show when subscribing (optional, only relevant in the demo)>,
	"token": "<token to require via Bearer authorization when using WHEP (optional)>,
	"iceServers": [ array of STUN/TURN servers to return via Link headers (optional) ]
}
```

If successful, a 200 OK will be returned, and the `/endpoint/<id>` endpoint will become available in the REST API: sending an empty POST to that resource using the WHEP API would lead the server to automatically create a Streaming plugin subscriber in the specified mountpoint. A simple example to create an endpoint using curl is the following:

	curl -H 'Content-Type: application/json' -d '{"id": "abc123", "mountpoint": 1}' http://localhost:7090/whep/create

Notice that the server will not create the Streaming mountpoint for you. In the example above, the specified mountpoint `1` must exist already, or any attempt to subscribe there will fail.

Subscribing to the WHEP endpoint via WebRTC can be done by sending either an SDP offer or an empty request to the created `/endpoint/<id>` endpoint via HTTP POST, which will interact with Janus on your behalf. Depending on what you sent, if successful, it will return an SDP answer or offer back in the 200 OK, plus an address for the allocated resource; if you sent an empty request initially, to complete the negotiation you'll have to send the SDP answer to the resource URL via PATCH. If you're using [Simple WHEP Client](https://github.com/meetecho/simple-whep-client) to test, the full HTTP path to the endpoint is all you need to provide as the WHEP url. Notice that, to be able to send an offer to the WHP endpoint you'll need to use at least the 1.1.4 version of Janus.

As per the specification, the response to the subscribe request will contain a `Location` header which points to the resource to use to refer to the stream. In this prototype implementation, the resource is handled by the same server instance, and is currently generated automatically as a `/resource/<uuid>` endpoint (returned as a relative path in the header), where `uuid` is randomly generated and unique for each subscriber. That's the address used for interacting with the session, i.e., for tricking candidates, restarting ICE, and tearing down the session. The server is configured to automatically allow trickle candidates to be sent via HTTP PATCH to the `/resource/<uuid>` endpoint: if you'd like the server to not allow trickle candidates instead (e.g., to test if your client handles a failure gracefully), you can disable them in the configuration file. ICE restarts are currently not supported. Finally, that's also the address you'll need to send the HTTP DELETE request to, in case you want to signal the intention to tear down the WebRTC PeerConnection.

Notice that a DELETE to the resource endpoint will only tear down the PeerConnection, but will preserve the endpoint, meaning new WHEP subscriptions on the same Janus mountpoint can be created again: to permanently destroy an existing endpoint, you can issue a DELETE to the `/endpoint/<id>` endpoint instead. For testing purposes, you can retrieve a list of the created endpoints by sending a GET to the `/endpoints` resource: notice that, since this is a testbed implementation, this request is not authenticated. A list of subscribers is also available at the `/subscribers` resource, again only for debugging purposes.

# Web demo

To make the management of endpoints easier, the server comes with an intergrated web demo, available at the base address of the web server, e.g.:

	http://localhost:7090

The demo allows you to visually create, list, watch and destroy endpoints, using the same REST APIs introduced previously. Once an endpoint has been created, the `watch.html` page can be used to use WHEP to subscribe to it, which expects the ID of the endpoint as part of the query string. Notice that, by default, the demo will expect an offer from the server: to have the demo send an offer instead, add an `offer=true` query string argument to the URL.
