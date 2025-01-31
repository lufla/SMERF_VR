import { WEBGL } from './WebGL.js';
console.log('VRButton module loaded!');

class VRButton {
	static createButton(renderer) {
		// Debug: Initializing VRButton creation
		console.log('Creating VRButton...');

		// Create the button element
		const button = document.createElement('button');
		console.log('Button element created.');

		// Function to handle entering VR mode
		function showEnterVR() {
			console.log('Preparing to show Enter VR button...');
			let currentSession = null;

			async function onSessionStarted(session) {
				session.addEventListener('end', onSessionEnded);
				await renderer.xr.setSession(session);
				button.textContent = 'EXIT VR';
				currentSession = session;
			}

			function onSessionEnded() {
				if (currentSession) {
					currentSession.removeEventListener('end', onSessionEnded);
					currentSession = null;
				}
				button.textContent = 'ENTER VR';
				console.log('XR session ended.');
			}


			// Style and interaction setup
			button.style.display = '';
			button.style.cursor = 'pointer';
			button.style.left = 'calc(50% - 50px)';
			button.style.width = '100px';
			button.textContent = 'ENTER VR';
			console.log('Enter VR button styled and ready.');

			// Hover effects
			button.onmouseenter = () => {
				button.style.opacity = '1.0';
				console.log('Mouse entered the button.');
			};
			button.onmouseleave = () => {
				button.style.opacity = '0.5';
				console.log('Mouse left the button.');
			};

			// Click event for VR session
			button.onclick = () => {
				if (currentSession === null) {
					console.log('Requesting immersive VR session...');
					const sessionInit = { optionalFeatures: ['local-floor', 'bounded-floor'] }; // Remove unsupported 'layers'
					navigator.xr
						.requestSession('immersive-vr', sessionInit)
						.then(onSessionStarted)
						.catch((error) => {
							console.error('Failed to start VR session:', error);
						});
				} else {
					console.log('Ending current VR session...');
					currentSession.end();
				}
			};
		}

		// Function to disable the button
		function disableButton() {
			console.log('Disabling VRButton...');
			button.style.display = '';
			button.style.cursor = 'auto';
			button.style.left = 'calc(50% - 50px)';
			button.style.width = '100px';
			button.onmouseenter = null;
			button.onmouseleave = null;
			button.onclick = null;
		}

		// Function to show WebXR not found error
		function showWebXRNotFound() {
			console.warn('WebXR not supported.');
			disableButton();
			button.textContent = 'VR NOT SUPPORTED';
		}

		// Check if WebXR is supported
		if ('xr' in navigator) {
			console.log('WebXR detected in navigator.');
			button.id = 'VRButton';
			button.style.display = 'none';

			navigator.xr
				.isSessionSupported('immersive-vr')
				.then((supported) => {
					if (supported) {
						console.log('Immersive VR supported.');
						showEnterVR();
					} else {
						console.warn('Immersive VR not supported.');
						showWebXRNotFound();
					}
				})
				.catch((error) => {
					console.error('Error checking immersive VR support:', error);
					showWebXRNotFound();
				});

			console.log('Returning VRButton element.');
			return button;
		} else {
			// Fallback for unsupported browsers
			console.warn('WebXR not available. Creating fallback message.');

			const message = document.createElement('a');
			if (window.isSecureContext === false) {
				console.warn('WebXR requires HTTPS.');
				message.href = document.location.href.replace(/^http:/, 'https:');
				message.innerHTML = 'WEBXR NEEDS HTTPS';
			} else {
				message.href = 'https://immersiveweb.dev/';
				message.innerHTML = 'WEBXR NOT AVAILABLE';
			}

			message.style.left = 'calc(50% - 50px)';
			message.style.width = '100px';
			message.style.textDecoration = 'none';

			console.log('Returning fallback message element.');
			return message;
		}
	}
}

