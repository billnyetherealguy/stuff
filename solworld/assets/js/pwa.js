// Solworld as an app: the service worker, and an "Install app" button that
// uses the browser's install prompt (Android, Chrome, Edge) or explains
// Add to Home Screen where there is none (iPhone and iPad Safari).
import { Emitter } from './emitter.js';

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function registerServiceWorker() {
  // Not under automation: test runs mock the network, which a worker would bypass.
  if (!('serviceWorker' in navigator) || navigator.webdriver || !isSecureContext) return;
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

export class Installer extends Emitter {
  constructor() {
    super();
    this.prompt = null;
    addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); // show our own button instead of the browser's mini-bar
      this.prompt = e;
      this.emit('change');
    });
    addEventListener('appinstalled', () => {
      this.prompt = null;
      this.installed = true;
      this.emit('change');
    });
  }

  /** Whether to offer "Install app" at all. */
  get available() {
    return !this.installed && !isStandalone() && (!!this.prompt || isIOS());
  }

  /** Runs the install. Returns 'prompted' | 'ios' (show the Add to Home Screen steps) | 'none'. */
  async install() {
    if (this.prompt) {
      const e = this.prompt;
      this.prompt = null;
      e.prompt();
      await e.userChoice.catch(() => null);
      this.emit('change');
      return 'prompted';
    }
    return isIOS() ? 'ios' : 'none';
  }
}
