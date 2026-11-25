/* W Projection — petit moteur de rendu pour les pages du site.
   Lit le gabarit <x-dc> et la classe Component de chaque page, puis met
   l'écran à jour avec morphdom pour ne jamais relancer les animations. */
(function () {
  'use strict';

  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };
  var EVENTS = {
    onclick: 'click', onpointermove: 'pointermove', onpointerdown: 'pointerdown', onpointerup: 'pointerup',
    onpointercancel: 'pointercancel', onpointerenter: 'pointerenter', onpointerleave: 'pointerleave',
    onscroll: 'scroll', onchange: 'change', oninput: 'input'
  };
  var NON_BUBBLING = { pointerenter: 1, pointerleave: 1, scroll: 1 };

  function DCLogic(props) { this.props = props || {}; this.state = {}; }
  DCLogic.prototype.setState = function (patch) {
    var next = typeof patch === 'function' ? patch(this.state, this.props) : patch;
    this.state = Object.assign({}, this.state, next);
    if (this.__schedule) this.__schedule();
  };
  window.DCLogic = DCLogic;

  function escText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  function resolve(expr, scope) {
    expr = expr.trim();
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
    var parts = expr.split('.');
    var v = scope;
    for (var i = 0; i < parts.length; i++) {
      if (v == null) return undefined;
      v = v[parts[i]];
    }
    return v;
  }
  var HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  var WHOLE = /^\{\{\s*([^}]+?)\s*\}\}$/;
  function interp(str, scope) {
    return str.replace(HOLE, function (m, e) { var v = resolve(e, scope); return v == null || v === false ? '' : String(v); });
  }

  function makeRenderer(registry) {
    function renderChildren(node, scope) {
      var out = '';
      for (var c = node.firstChild; c; c = c.nextSibling) out += renderNode(c, scope);
      return out;
    }
    function renderNode(node, scope) {
      if (node.nodeType === 3) return escText(interp(node.nodeValue, scope));
      if (node.nodeType !== 1) return '';
      var tag = node.localName;
      if (tag === 'sc-for') {
        var list = resolve((node.getAttribute('list') || '').replace(/[{}]/g, ''), scope) || [];
        var as = node.getAttribute('as') || 'item';
        var out = '';
        for (var i = 0; i < list.length; i++) {
          var s2 = Object.create(scope);
          s2[as] = list[i];
          out += renderChildren(node, s2);
        }
        return out;
      }
      if (tag === 'sc-if') {
        var val = resolve((node.getAttribute('value') || '').replace(/[{}]/g, ''), scope);
        return val ? renderChildren(node, scope) : '';
      }
      var attrs = '';
      for (var a = 0; a < node.attributes.length; a++) {
        var at = node.attributes[a];
        var name = at.name;
        if (name.indexOf('hint-') === 0) continue;
        var lower = name.toLowerCase();
        if (EVENTS[lower]) {
          var fnM = WHOLE.exec(at.value);
          var fn = fnM ? resolve(fnM[1], scope) : null;
          if (typeof fn === 'function') {
            registry.push(fn);
            attrs += ' data-dc-' + EVENTS[lower] + '="' + (registry.length - 1) + '"';
          }
          continue;
        }
        if (name === 'ref') {
          var refM = WHOLE.exec(at.value);
          var rf = refM ? resolve(refM[1], scope) : null;
          if (typeof rf === 'function') {
            registry.refs.push(rf);
            attrs += ' data-dc-ref="' + (registry.refs.length - 1) + '"';
          }
          continue;
        }
        var whole = WHOLE.exec(at.value);
        if (whole) {
          var v = resolve(whole[1], scope);
          if (v === false || v == null) continue;
          if (v === true) { attrs += ' ' + name; continue; }
          attrs += ' ' + name + '="' + escAttr(v) + '"';
        } else {
          attrs += ' ' + name + '="' + escAttr(interp(at.value, scope)) + '"';
        }
      }
      var open = '<' + tag + attrs + '>';
      if (VOID[tag]) return open;
      var inner = tag === 'template' ? renderChildren(node.content, scope) : renderChildren(node, scope);
      return open + inner + '</' + tag + '>';
    }
    return renderChildren;
  }

  function boot() {
    var host = document.querySelector('x-dc');
    var scriptEl = document.querySelector('script[data-dc-script]');
    if (!host || !scriptEl) return;

    var helmet = host.querySelector('helmet');
    if (helmet) {
      while (helmet.firstChild) {
        var n = helmet.firstChild;
        helmet.removeChild(n);
        if (n.nodeType === 1) document.head.appendChild(n);
      }
      helmet.parentNode.removeChild(helmet);
    }
    var tpl = document.createElement('template');
    tpl.innerHTML = host.innerHTML;
    host.parentNode.removeChild(host);

    var props = {};
    try {
      var decl = JSON.parse(scriptEl.getAttribute('data-props') || '{}');
      Object.keys(decl).forEach(function (k) { if (k.charAt(0) !== '$' && decl[k] && 'default' in decl[k]) props[k] = decl[k].default; });
    } catch (e) { /* pas de props */ }

    var Component = new Function('DCLogic', scriptEl.textContent + '\nreturn Component;')(DCLogic);
    var comp = new Component(props);
    if (!comp.state) comp.state = {};

    var root = document.getElementById('dc-root');
    if (!root) { root = document.createElement('div'); root.id = 'dc-root'; document.body.insertBefore(root, document.body.firstChild); }

    var registry = [];
    var pending = false;
    function render() {
      pending = false;
      var reg = []; reg.refs = [];
      var html = makeRenderer(reg)(tpl.content, comp.renderVals());
      var next = document.createElement('div');
      next.id = 'dc-root';
      next.innerHTML = html;
      var saved = {};
      var fileInputs = {};
      root.querySelectorAll('input[name], textarea[name]').forEach(function (el) {
        if (el.type === 'file') fileInputs[el.name] = el;
        else if (el.type !== 'checkbox' && el.type !== 'radio') saved[el.name] = el.value;
      });
      var focused = document.activeElement && document.activeElement.name;
      window.morphdom(root, next, {
        getNodeKey: function (node) {
          if (node.nodeType !== 1) return null;
          if (node.id) return node.id;
          var nm = node.getAttribute('name');
          if (nm && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA')) return 'f:' + nm;
          return null;
        },
        onBeforeElUpdated: function (from) {
          return !(from.tagName === 'INPUT' && from.type === 'file');
        }
      });
      root.querySelectorAll('input[name], textarea[name]').forEach(function (el) {
        if (el.type === 'file') return;
        if (el.type !== 'checkbox' && el.type !== 'radio' && saved[el.name] != null && el.value !== saved[el.name]) el.value = saved[el.name];
      });
      if (focused) { var fe = root.querySelector('[name="' + focused + '"]'); if (fe && document.activeElement !== fe) fe.focus(); }
      registry = reg;
      var refs = root.querySelectorAll('[data-dc-ref]');
      for (var i = 0; i < refs.length; i++) { var f = reg.refs[+refs[i].getAttribute('data-dc-ref')]; if (f) f(refs[i]); }
    }
    comp.__schedule = function () { if (!pending) { pending = true; requestAnimationFrame(render); } };

    function dispatch(type, e) {
      var stopped = false;
      function wrap(el) {
        return new Proxy(e, {
          get: function (t, k) {
            if (k === 'currentTarget') return el;
            if (k === 'stopPropagation') return function () { stopped = true; t.stopPropagation(); };
            var v = t[k];
            return typeof v === 'function' ? v.bind(t) : v;
          }
        });
      }
      var attr = 'data-dc-' + type;
      var el = e.target && e.target.nodeType === 1 ? e.target : (e.target && e.target.parentElement);
      if (NON_BUBBLING[type]) {
        if (el && el.hasAttribute && el.hasAttribute(attr)) { var f0 = registry[+el.getAttribute(attr)]; if (f0) f0(wrap(el)); }
        return;
      }
      while (el && el !== document.documentElement) {
        if (el.hasAttribute && el.hasAttribute(attr)) {
          var f = registry[+el.getAttribute(attr)];
          if (f) f(wrap(el));
          if (stopped) break;
        }
        el = el.parentElement;
      }
    }
    Object.keys(EVENTS).forEach(function (k) {
      var type = EVENTS[k];
      document.addEventListener(type, function (e) { dispatch(type, e); }, NON_BUBBLING[type] ? true : false);
    });

    render();
    if (typeof comp.componentDidMount === 'function') comp.componentDidMount();
    window.addEventListener('pagehide', function () { if (typeof comp.componentWillUnmount === 'function') comp.componentWillUnmount(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
