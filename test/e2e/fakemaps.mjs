// A tiny stand-in for the Google Maps JavaScript API (Street View parts only),
// so the in-site "drop into the street" flow can be tested offline.
export const FAKE_MAPS_JS = `
(() => {
  const cbName = new URL(document.currentScript.src).searchParams.get('callback');
  class LatLng { constructor(lat, lng) { this._lat = lat; this._lng = lng; } lat() { return this._lat; } lng() { return this._lng; } }
  class Size { constructor(w, h) { this.width = w; this.height = h; } }
  class StreetViewService {
    async getPanorama({ location }) {
      return { data: { location: { pano: 'harness-pano', latLng: new LatLng(location.lat + 0.0002, location.lng) } } };
    }
  }
  class StreetViewPanorama {
    constructor(div) {
      this.div = div;
      div.innerHTML = '<div class="fake-pano" style="position:absolute;inset:0;background:linear-gradient(#8fb5dd 0 45%, #6d6a64 45% 70%, #3a3a3c 70%);"></div>';
      window.__fakePano = this;
    }
    setPano(p) { this.pano = p; }
    setPov(p) { this.pov = p; }
    setZoom(z) { this.zoom = z; }
    setVisible(v) { this.visible = v; }
  }
  class Marker {
    constructor({ position, map, title, icon }) {
      this.el = document.createElement('img');
      this.el.className = 'fake-marker';
      this.el.title = title;
      this.el.src = icon.url;
      this.el.style.cssText = 'position:absolute;left:' + (30 + Math.random() * 50) + '%;top:' + (25 + Math.random() * 20) + '%;width:' + icon.scaledSize.width + 'px;cursor:pointer';
      map.div.append(this.el);
      this.position = position;
    }
    addListener(type, fn) { this.el.addEventListener(type, fn); }
    setMap(m) { if (!m) this.el.remove(); }
  }
  const libs = { streetView: { StreetViewPanorama, StreetViewService, StreetViewSource: { OUTDOOR: 'outdoor' }, StreetViewPreference: { NEAREST: 'nearest' } }, marker: { Marker }, core: { Size, LatLng } };
  window.google = { maps: { importLibrary: async (n) => libs[n], Size, LatLng } };
  setTimeout(() => window[cbName] && window[cbName](), 10);
})();
`;
