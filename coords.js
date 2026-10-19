/* Geometria condivisa tra l'app e i test.
 *
 * Le annotazioni sono in punti "viewport": origine in alto a sinistra della
 * pagina come la si vede a schermo (rotazione /Rotate già applicata), y verso
 * il basso. Il PDF invece ha origine in basso a sinistra, y verso l'alto, e
 * ignora /Rotate. Qui sta tutta la conversione tra i due sistemi.
 */
(function (root) {
  const LINE_HEIGHT = 1.18;  // moltiplicatore interlinea
  const BASELINE = 0.81;     // baseline dal bordo alto della riga, in em

  /** Punto viewport -> punto PDF. W, H = MediaBox non ruotata. */
  function vpToPdf(xv, yv, R, W, H) {
    switch (R) {
      case 90:  return { x: yv, y: xv };
      case 180: return { x: W - xv, y: yv };
      case 270: return { x: W - yv, y: H - xv };
      default:  return { x: xv, y: H - yv };
    }
  }

  /** Rettangolo viewport -> rettangolo PDF allineato agli assi. */
  function rectToPdf(a, R, W, H) {
    const pts = [
      vpToPdf(a.x, a.y, R, W, H),
      vpToPdf(a.x + a.w, a.y, R, W, H),
      vpToPdf(a.x, a.y + a.h, R, W, H),
      vpToPdf(a.x + a.w, a.y + a.h, R, W, H),
    ];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }

  /** Ancoraggio PDF di un'immagine: spigolo basso-sinistra nel suo orientamento. */
  function imageAnchor(a, R, W, H) {
    return vpToPdf(a.x, a.y + a.h, R, W, H);
  }

  /** Baseline PDF della riga i di un blocco di testo. */
  function textBaseline(a, i, R, W, H) {
    const yv = a.y + a.size * BASELINE + i * a.size * LINE_HEIGHT;
    return vpToPdf(a.x, yv, R, W, H);
  }

  // Caratteri rappresentabili dal font Helvetica standard (codifica WinAnsi).
  const EXTRA_WINANSI = new Set([...'‚„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸƒ€']);

  function sanitize(text) {
    let dropped = 0;
    const out = [...text].map((ch) => {
      const c = ch.codePointAt(0);
      if (ch === '\n' || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || EXTRA_WINANSI.has(ch)) return ch;
      dropped++;
      return '';
    }).join('');
    return { text: out, dropped };
  }

  root.PdfCoords = { LINE_HEIGHT, BASELINE, vpToPdf, rectToPdf, imageAnchor, textBaseline, sanitize };
})(typeof module !== 'undefined' && module.exports ? module.exports : window);
