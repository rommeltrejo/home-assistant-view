'use strict';
// HTTPS completion is opt-in for typed addresses, never redirects or requests.
function externalURL(value, completeAddress = false) {
  const invalid = () => { throw new Error('Enter a website address such as duckduckgo.com, or an http:// or https:// URL without credentials.'); };
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) invalid();
  const explicit = /^https?:\/\//i.test(value);
  if (!explicit && !completeAddress) invalid();
  const authority = (explicit ? value.replace(/^https?:\/\//i, '') : value).split(/[/?#]/)[0];
  // Validate the authority before URL parsing can repair slashes or discard userinfo.
  if (!authority || authority.includes('@') || authority.includes('%')) invalid();
  const hostPort = authority.match(/^(\[[0-9a-f:.]+\]|[^:]+)(?::([0-9]+))?$/i);
  if (!hostPort) invalid();
  const host = hostPort[1];
  if (!host.startsWith('[')) {
    const labels = host.replace(/\.$/, '').split('.');
    if (labels.some(label => !label || !/^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(label) || label.length > 63)) invalid();
    if (!explicit && labels.length < 2 && host.toLowerCase() !== 'localhost') invalid();
  }
  let url;
  try { url = new URL(explicit ? value : `https://${value}`); } catch { invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) invalid();
  return url.href;
}
function geometry(width, height) {
  width = Math.max(1, Math.floor(width)); height = Math.max(1, Math.floor(height));
  const x = Math.floor(width * .025), y = Math.floor(height * .025);
  const w = width - 2 * x, h = height - 2 * y;
  const toolbar = Math.min(Math.max(0, h - 1), width < 500 ? 144 : 104);
  return { shell: { x: 0, y: 0, width, height }, page: { x: Math.min(width - 1, x + 1), y: y + toolbar, width: Math.max(1, Math.min(width - Math.min(width - 1, x + 1), w - 2)), height: Math.max(1, h - toolbar - 1) }, launcher: { x: Math.max(0, width - 64), y: Math.max(0, height - 64), width: Math.min(48, width), height: Math.min(48, height) } };
}
const BUILTINS = Object.freeze([
  { id: 'duckduckgo', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q={query}' },
  { id: 'google', name: 'Google', template: 'https://www.google.com/search?q={query}' },
  { id: 'bing', name: 'Bing', template: 'https://www.bing.com/search?q={query}' }
].map(Object.freeze));
const defaults = () => ({ enabled: true, provider: 'duckduckgo', customProviders: [] });
function validateProvider(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['id', 'name', 'template'].includes(k))) throw new Error('Invalid provider');
  const { id, name, template } = value;
  if (typeof id !== 'string' || !/^custom-[a-z0-9-]{1,64}$/.test(id) || typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 60 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new Error('Invalid provider name');
  if (typeof template !== 'string' || template.length > 2048 || template.split('{query}').length !== 2 || /[{}]/.test(template.replace('{query}', ''))) throw new Error('Use exactly one {query} placeholder');
  // Inspect the raw authority, before URL parsing can normalize malformed intent.
  const match = template.match(/^https?:\/\/[^/?#]+([/?][^#]*)?(?:#.*)?$/i);
  if (!match || !match[1]?.includes('{query}')) throw new Error('Place {query} in the URL path or query only');
  externalURL(template.replace('{query}', 'test'));
  return { id, name, template };
}
function validateSearch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['enabled', 'provider', 'customProviders'].includes(k)) || typeof value.enabled !== 'boolean' || !Array.isArray(value.customProviders) || value.customProviders.length > 20) throw new Error('Invalid search preferences');
  const customProviders = value.customProviders.map(validateProvider);
  const all = [...BUILTINS, ...customProviders];
  if (new Set(all.map(p => p.id)).size !== all.length || new Set(all.map(p => p.name.toLowerCase())).size !== all.length || !all.some(p => p.id === value.provider)) throw new Error('Invalid search provider');
  return { enabled: value.enabled, provider: value.provider, customProviders };
}
function typedURL(value, search = defaults()) {
  try { return externalURL(value, true); } catch {}
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u001f\u007f-\u009f\\]/.test(value)) throw new Error('Invalid website address');
  const query = value.trim();
  // Explicit scheme intent is not search text, even with whitespace inserted
  // into the scheme or malformed slashes. Inspect embedded schemes as well so
  // credential-bearing URLs in surrounding prose never reach a provider.
  const compact = query.replace(/\s/gu, '');
  const schemeIntent = /^[a-z][a-z0-9+.-]*:/i.test(query) || /^(?:https?|javascript|data|file|ftp|about|chrome|vbscript):/i.test(compact) || /[a-z][a-z0-9+.-]*:\/*[^\s]*@/i.test(compact) || /[a-z][a-z0-9+.-]*:\/\//i.test(compact);
  // Also protect scheme-less and whitespace-obfuscated userinfo. Treat @ as
  // sensitive intent rather than attempting to repair or extract credentials.
  const credentials = /@|%40/i.test(query);
  const singleTokenAddress = !/\s/u.test(query) && /[:/%]|\S\.\S|[\[\]]/.test(query);
  if (schemeIntent || credentials || singleTokenAddress || /^\/\//.test(query)) throw new Error('Invalid website address');
  const prefs = validateSearch(search);
  if (!prefs.enabled) throw new Error('Type to search is disabled');
  const provider = [...BUILTINS, ...prefs.customProviders].find(p => p.id === prefs.provider);
  return externalURL(provider.template.replace('{query}', encodeURIComponent(value.trim())));
}


module.exports = { externalURL, geometry, BUILTINS, defaults, validateProvider, validateSearch, typedURL };
