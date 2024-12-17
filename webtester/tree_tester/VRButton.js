// VRButton.js
class VRButton {
	static createButton(renderer) {
		const button = document.createElement('button');

		function showEnterVR() {
			let currentSession = null;

			async function onSessionStarted(session) {
				session.addEventListener('end', onSessionEnded);
				await renderer.xr.setSession(session);
				button.textContent = 'EXIT VR';
				currentSession = session;
			}

			function onSessionEnded(/*event*/) {
				currentSession.removeEventListener('end', onSessionEnded);
				button.textContent = 'ENTER VR';
				currentSession = null;
			}

			if (navigator.xr) {
				button.style.display = '';
				button.style.cursor = 'pointer';
				button.style.left = 'calc(50% - 50px)';
				button.style.width = '100px';
				button.style.position = 'absolute';
				button.style.bottom = '20px';
				button.style.padding = '12px 6px';
				button.style.border = '1px solid #fff';
				button.style.borderRadius = '4px';
				button.style.background = 'rgba(0,0,0,0.1)';
				button.style.color = '#fff';
				button.style.font = 'normal 13px sans-serif';
				button.style.textAlign = 'center';
				button.style.opacity = '0.5';
				button.style.outline = 'none';
				button.style.zIndex = '999';

				button.onmouseenter = () => { button.style.opacity = '1.0'; };
				button.onmouseleave = () => { button.style.opacity = '0.5'; };

				button.textContent = 'ENTER VR';

				button.onclick = () => {
					if (currentSession === null) {
						const sessionInit = { optionalFeatures: ['local-floor', 'bounded-floor'] };
						navigator.xr.requestSession('immersive-vr', sessionInit).then(onSessionStarted);
					} else {
						currentSession.end();
					}
				};
			} else {
				button.style.display = 'none';
				console.warn('WebXR not available');
			}
		}

		if ('xr' in navigator) {
			showEnterVR();
		} else {
			const message = document.createElement('a');
			if (window.isSecureContext === false) {
				message.href = document.location.href.replace(/^http:/, 'https:');
				message.innerHTML = 'WEBXR NEEDS HTTPS';
			} else {
				message.href = 'https://immersiveweb.dev/';
				message.innerHTML = 'WEBXR NOT AVAILABLE';
			}
			message.style.left = 'calc(50% - 90px)';
			message.style.width = '180px';
			message.style.textDecoration = 'none';
			button.style.display = 'none';
			document.body.appendChild(message);
		}

		return button;
	}
}

export { VRButton };
