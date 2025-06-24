Simple WHEP Server examples
===========================

This folder contains a few example applications using the Janus WHEP library.

* The `server-owned` folder contains an example where the application asks the library to create a new REST server to host the WHEP functionality, binding to the provided port. A separate REST server is then spawned by the application for its own purposes (e.g., listing the available endpoints). A sample endpoint is created, with a static token.

* The `server-shared` folder, instead, contains an example where the application pre-creates a REST server for its own needs, and then tells the library to re-use that server for the WHEP functionality too. A sample endpoint is created, with a callback function used to validate the token any time one is presented.

* The `videoroom` folder shows how you can configure a WHEP endpoint to rely on the VideoRoom plugin, instead of the Streaming (which is the default), thus simply subscribing to an existing and active publisher in a room.

* The `recordplay` folder shows how you can configure a WHEP endpoint to rely on the RecordPlay plugin, instead of the Streaming (which is the default), thus simply playing an existing Janus recording.

All demos subscribe to a few of the events the library can emit for debugging purposes, and serve the `web` folder as static file, which provides a basic WHEP player. Assuming the endpoint `abc123` is available at the WHEP server, you can watch it like that:

	http://localhost:PORT/?id=abc123

where `PORT` is `7190` in the `server-owned`, `videoroom` and `recordplay` examples, and `7090` in the `server-shared` example.

Notice that, should you want Janus to send the offer (non-standard WHEP), you can do that by passing an additional `offer=false` to the query string. This is currently required when trying the `videoroom` or `recordplay` demos, as neither the VideoRoom nor the Record&Play plugins support accepting an offer from subscribers: the only plugin that supports that is the Streaming plugin, which is why it's the default when using the WHEP server library.
