Simple WHEP Server examples
===========================

This folder contains a few example applications using the Janus WHEP library.

* The `server-owned` folder contains an example where the application asks the library to create a new REST server to host the WHEP functionality, binding to the provided port. A separate REST server is then spawned by the application for its own purposes (e.g., listing the available endpoints). A sample endpoint is created, with a static token.

* The `server-shared` folder, instead, contains an example where the application pre-creates a REST server for its own needs, and then tells the library to re-use that server for the WHEP functionality too. A sample endpoint is created, with a callback function used to validate the token any time one is presented.

Both demos subscribe to a few of the events the library can emit for debugging purposes, and serve the `web` folder as static file, which provides a basic WHEP player. Assuming the endpoint `abc123` is available at the WHEP server, you can watch it like that:

	http://localhost:PORT/?id=abc123

where `PORT` is `7190` in the `server-owned` example, and `7090` in the `server-shared` example. Notice that, should you want Janus to send the offer (non-standard WHEP), you can do that by passing an additional `offer=false` to the query string.
