import { base64 } from '../../tooling/base64.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The line as SVG, 256 x 128 px (192 x 96 pt, the size Word gives it). */
export function signatureSvg({ signer = '', title = '' } = {}) {
  const text = (y, t) => (t.trim() ? `<text x="8" y="${y}" font-family="Calibri" font-size="14">${esc(t.trim())}</text>` : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128" viewBox="0 0 256 128">`
    + `<text x="8" y="72" font-family="Calibri" font-size="36">X</text><line x1="0" y1="80" x2="256" y2="80" stroke="#000000" stroke-width="1.5"/>`
    + `${text(98, signer)}${text(114, title)}</svg>`;
}

export const signatureData = (o) => base64(new TextEncoder().encode(signatureSvg(o)));

export const signatureAlt = ({ signer = '' } = {}) => (signer.trim() ? `Signature line for ${signer.trim()}` : 'Signature line');
