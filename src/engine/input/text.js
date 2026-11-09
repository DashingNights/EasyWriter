// Where typed text and input-method compositions come from in the canvas editor (docs/plans/engine/plan.md section 1): an
// EditContext on the page area, or a hidden textarea at the caret in a browser without EditContext (Firefox, Safari).
// Both keep their own text empty between compositions, so whatever they hold is the composition: the engine's document is the
// only copy of the text. ponytail: no surrounding text is mirrored, so an input method cannot reconvert committed text; mirror
// the caret's paragraph (engine text() around the caret) when one needs it.
//
// `host` hears: insert(text, event), compose(text, selStart, selEnd), commit(), formats(list) (EditContext's TextFormat ranges)
// and bounds(rangeStart) (the input method asks where the composition's characters are).

/** The text source on page area `el`, EditContext unless `editContext` is false → {target (the element that takes the focus),
 * place(control, caret) (client DOMRects: the candidate window's anchor), chars(start, rects), finish(), destroy()}.
 * finish() drops an open composition without telling `host` (the host commits it itself) and blurs the target, so the browser
 * ends the input method's composition; the caller focuses the target again. */
export function textSource(el, host, { editContext = typeof EditContext === 'function' } = {}) {
  return editContext ? withEditContext(el, host) : withTextarea(el, host);
}

function listen(target, handlers) {
  for (const [name, fn] of Object.entries(handlers)) target.addEventListener(name, fn);
  return () => {
    for (const [name, fn] of Object.entries(handlers)) target.removeEventListener(name, fn);
  };
}

function withEditContext(el, host) {
  const ec = new EditContext();
  el.editContext = ec;
  let composing = false;
  const clear = () => {
    ec.updateText(0, ec.text.length, '');
    ec.updateSelection(0, 0);
  };
  const off = listen(ec, {
    // The text is already in ec.text when this fires; outside a composition the update is new typing at the caret.
    textupdate: (e) => {
      if (composing) host.compose(ec.text, e.selectionStart, e.selectionEnd);
      else {
        host.insert(e.text, e);
        clear();
      }
    },
    textformatupdate: (e) => host.formats(e.getTextFormats()),
    characterboundsupdate: (e) => host.bounds(e.rangeStart),
    compositionstart: () => {
      composing = true;
    },
    compositionend: () => {
      if (composing) host.commit(); // not after finish(), which committed it
      composing = false;
      clear();
    },
  });
  return {
    target: el,
    finish() {
      composing = false;
      clear();
      el.blur?.();
    },
    place(control, caret) {
      ec.updateControlBounds(control);
      ec.updateSelectionBounds(caret);
    },
    chars: (start, rects) => ec.updateCharacterBounds(start, rects),
    destroy() {
      off();
      if (el.editContext === ec) el.editContext = null;
    },
  };
}

function withTextarea(el, host) {
  const ta = el.ownerDocument.createElement('textarea');
  ta.tabIndex = -1;
  ta.setAttribute('aria-hidden', 'true'); // engine-a11y gives screen readers the text; this box only takes keys
  for (const [k, v] of Object.entries({ autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false' })) ta.setAttribute(k, v);
  // Invisible but laid out: input methods put the candidate window at its caret, so place() keeps it at the engine's caret.
  Object.assign(ta.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '1em', padding: '0', border: '0', margin: '0',
    opacity: '0', resize: 'none', overflow: 'hidden', whiteSpace: 'pre', pointerEvents: 'none', caretColor: 'transparent' });
  el.append(ta);
  let composing = false;
  const offEl = listen(el, {
    focus: () => ta.focus({ preventScroll: true }),
  });
  const offTa = listen(ta, {
    compositionstart: () => {
      composing = true;
    },
    input: (e) => {
      if (composing) return host.compose(ta.value, ta.selectionStart, ta.selectionEnd);
      // Safari sends the committed text again after compositionend; that commit went through compositionend already.
      if (e.inputType !== 'insertFromComposition' && ta.value) host.insert(ta.value, e);
      ta.value = '';
    },
    compositionend: (e) => {
      if (composing) {
        const t = e.data ?? '';
        host.compose(t, t.length, t.length);
        host.commit();
      }
      composing = false;
      ta.value = '';
    },
  });
  return {
    target: ta,
    finish() {
      composing = false;
      ta.value = '';
      ta.blur?.();
    },
    place(control, caret) {
      Object.assign(ta.style, { left: `${caret.x}px`, top: `${caret.y}px`, height: `${Math.max(1, caret.height)}px`, fontSize: `${Math.max(1, caret.height * 0.8)}px` });
    },
    chars() {},
    destroy() {
      offEl();
      offTa();
      ta.remove();
    },
  };
}
