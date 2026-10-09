'use strict';
// Minimal non-raster DOM for the real UI2 scripts. Browser gates cover layout/font pixels.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
module.exports = function loadUI(box, el) {
  const noop = () => {};
  function node(tag = 'div') {
    const attrs = new Map(), children = [];
    const value = {tagName: tag.toUpperCase(), dataset: {}, style: {setProperty: noop}, children,
      hidden: false, isConnected: true, clientWidth: 320, className: '',
      classList: {toggle: noop, contains: name => value.className.split(' ').includes(name)},
      setAttribute: (key, text) => attrs.set(key, String(text)),
      getAttribute: key => attrs.get(key) ?? null,
      removeAttribute: key => attrs.delete(key),
      getContext: () => ({save: noop, restore: noop, fillRect: noop, drawImage: noop}),
      append: (...items) => children.push(...items),
      replaceChildren: (...items) => {children.splice(0, children.length, ...items);},
      querySelector: selector => {
        const matches = child => selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector.toUpperCase();
        for (const child of children) {if (matches(child)) return child; const nested = child.querySelector(selector); if (nested) return nested;}
        return null;
      },
      getBoundingClientRect: () => ({left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0}),
      focus: noop, setPointerCapture: noop, cloneNode: () => node(tag)};
    Object.defineProperty(value, 'firstChild', {get: () => children[0] ?? null});
    return value;
  }
  const select = box.document.querySelector;
  box.document.querySelector = selector => {
    const value = select(selector);
    if (!value.getAttribute) Object.assign(value, node(selector === '#stage' ? 'canvas' : 'div'));
    return value;
  };
  box.document.createElement = node;
  box.document.addEventListener = noop;
  box.document.documentElement = node();
  box.document.baseURI = 'https://example.org/';
  box.URL = URL;
  box.innerWidth ??= 1440; box.innerHeight ??= 900;
  box.getComputedStyle = () => ({display: 'block'});
  for (const file of ['font.js', 'ui-glyphs.js', 'ui-panels.js', 'quest/c-ui.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), box, {filename: file});
  }
  // Match initially closed drawers, so these timeline tests don't invoke font rasterization.
  for (const id of ['#camp', '#chron', '#quest']) box.document.querySelector(id).hidden = true;
  return state => el('#connection').getAttribute('aria-label') === ({
    file: 'Replay file normal', online: 'Connected · 10s normal',
    offline: 'Offline · retrying in 10s alert'
  })[state];
};
