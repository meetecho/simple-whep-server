// Base path for the REST WHEP API
var rest = '/whep';
var resource = null;

// PeerConnection
var pc = null;
var iceUfrag = null, icePwd = null;

// Helper function to get query string arguments
function getQueryStringValue(name) {
	name = name.replace(/[\[]/, '\\[').replace(/[\]]/, '\\]');
	let regex = new RegExp('[\\?&]' + name + '=([^&#]*)'),
		results = regex.exec(location.search);
	return results === null ? '' : decodeURIComponent(results[1].replace(/\+/g, ' '));
}
// Get the endpoint ID to subscribe to
var id = getQueryStringValue('id');

$(document).ready(function() {
	// Make sure WebRTC is supported by the browser
	if(!window.RTCPeerConnection) {
		bootbox.alert('WebRTC unsupported...');
		return;
	}
	if(!id) {
		bootbox.alert('Invalid endpoint ID...');
		return;
	}
	bootbox.prompt({
		title: 'Insert the endpoint token (leave it empty if not needed)',
		inputType: 'password',
		callback: function(result) {
			subscribeToEndpoint(result);
		}
	});
});

// Function to subscribe to the WHEP endpoint
function subscribeToEndpoint(token) {
	let headers = null;
	if(token)
		headers = { Authorization: 'Bearer ' + token };
	$.ajax({
		url: rest + '/endpoint/' + id,
		type: 'POST',
		headers: headers,
		data: {}
	}).error(function(xhr, textStatus, errorThrown) {
		bootbox.alert(xhr.status + ": " + xhr.responseText);
	}).success(function(sdp, textStatus, request) {
		console.log('Got offer:', sdp);
		resource = request.getResponseHeader('Location');
		console.log('WHEP resource:', resource);
		// TODO Parse ICE servers
		// let ice = request.getResponseHeader('Link');
		let iceServers = [{urls: "stun:stun.l.google.com:19302"}];
		// Create PeerConnection
		let pc_config = {
			sdpSemantics: 'unified-plan',
			iceServers: iceServers
		};
		pc = new RTCPeerConnection(pc_config);
		pc.oniceconnectionstatechange = function() {
			console.log('[ICE] ', pc.iceConnectionState);
		};
		pc.onicecandidate = function(event) {
			let end = false;
			if(!event.candidate || (event.candidate.candidate && event.candidate.candidate.indexOf('endOfCandidates') > 0)) {
				console.log('End of candidates');
				end = true;
			} else {
				console.log('Got candidate:', event.candidate.candidate);
			}
			if(!resource) {
				console.warn('No resource URL, ignoring candidate');
				return;
			}
			if(!iceUfrag || !icePwd) {
				console.warn('No ICE credentials, ignoring candidate');
				return;
			}
			// FIXME Trickle candidate
			let candidate =
				'a=ice-ufrag:' + iceUfrag + '\r\n' +
				'a=ice-pwd:' + icePwd + '\r\n' +
				'm=audio 9 RTP/AVP 0\r\n' +
				'a=' + (end ? 'end-of-candidates' : event.candidate.candidate) + '\r\n';
			$.ajax({
				url: resource,
				type: 'PATCH',
				headers: headers,
				contentType: 'application/trickle-ice-sdpfrag',
				data: candidate
			}).error(function(xhr, textStatus, errorThrown) {
				bootbox.alert(xhr.status + ": " + xhr.responseText);
			}).done(function(response) {
				console.log('Candidate sent');
			});
		};
		pc.ontrack = function(event) {
			console.log('Handling Remote Track', event);
			if(!event.streams)
				return;
			if($('#whepvideo').length === 0) {
				$('#video').removeClass('hide').show();
				$('#videoremote').append('<video class="rounded centered" id="whepvideo" width="100%" height="100%" autoplay playsinline/>');
			}
			attachMediaStream($('#whepvideo').get(0), event.streams[0]);
		};
		// Pass the offer to the PeerConnection
		let jsep = { type: 'offer', sdp: sdp };
		pc.setRemoteDescription(jsep)
			.then(function() {
				console.log('Remote description accepted');
				pc.createAnswer({})
					.then(function(answer) {
						console.log('Prepared answer:', answer.sdp);
						// Extract ICE ufrag and pwd (for trickle)
						iceUfrag = answer.sdp.match(/a=ice-ufrag:(.*)\r\n/)[1];
						icePwd = answer.sdp.match(/a=ice-pwd:(.*)\r\n/)[1];
						pc.setLocalDescription(answer)
							.then(function() {
								console.log('Sending answer to WHEP server');
								// Send the answer to the resource address
								$.ajax({
									url: resource,
									type: 'PATCH',
									headers: headers,
									contentType: 'application/sdp',
									data: answer.sdp
								}).error(function(xhr, textStatus, errorThrown) {
									bootbox.alert(xhr.status + ": " + xhr.responseText);
								}).done(function(response) {
									console.log('Negotiation completed');
								});
							}, function(err) {
								bootbox.alert(err.message);
							});
					}, function(err) {
						bootbox.alert(err.message);
					});
			}, function(err) {
				bootbox.alert(err.message);
			});
	});
}

// Helper function to attach a media stream to a video element
function attachMediaStream(element, stream) {
	try {
		element.srcObject = stream;
	} catch (e) {
		try {
			element.src = URL.createObjectURL(stream);
		} catch (e) {
			Janus.error("Error attaching stream to element", e);
		}
	}
};
