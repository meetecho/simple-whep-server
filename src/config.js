export default {

	// Janus info
	janus: {
		// WebSocket address
		address: 'ws://127.0.0.1:8188',
		// Janus API secret, if required
		//~ apiSecret: 'janusrocks'
	},

	// Port to bind the WHEP API to
	port: 7090,
	// By default we create a plain HTTP backend, but you can turn that
	// into an HTTPS one instead if you configure the certificate to use
	//~ https: {
		//~ cert: '/path/to/certificate',
		//~ key: '/path/to/privatekey',
		//~ passphrase: 'key passphrase, if required'
	//~ },

	// Base path for the REST WHEP API
	rest: '/whep',

	// Whether we should allow trickle candidates via API: if disabled,
	// we'll send back an HTTP 405 error as per the specification
	allowTrickle: true,

	// Whether we should be strict about ETags (as per the specification),
	// or whether we'll just generate them and accept whatever we get
	strictETags: false,

	// In case we need to always return a set of STUN/TURN servers to
	// WHEP clients via a Link header (unless some servers have been provided
	// as part of the endpoint creation request), we can put them here
	iceServers: [
		//~ { uri: 'stun:stun.example.net' },
		//~ { uri: 'turn:turn.example.net?transport=udp', username: 'user', credential: 'password' },
		//~ { uri: 'turn:turn.example.net?transport=tcp', username: 'user', credential: 'password' },
		//~ { uri: 'turns:turn.example.net?transport=tcp', username: 'user', credential: 'password' },
	]
};
