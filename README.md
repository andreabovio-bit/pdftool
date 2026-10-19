# PdfTool

Annota e firma PDF dal browser: testo, evidenziazioni, immagini e firme
disegnate a mano. **I file non vengono caricati da nessuna parte** — pdf.js e
pdf-lib lavorano interamente dentro la pagina, e questo sito è composto solo da
file statici: non esiste un server che possa ricevere i tuoi documenti.

Si installa: aprila su telefono e scegli "Aggiungi a Home". Dopo la prima
visita funziona anche senza rete.

## Cosa fa

| Strumento | Uso |
|---|---|
| **Testo** | tocca la pagina e scrivi; doppio tocco per ricorreggere |
| **Evidenzia** | trascina un rettangolo; blend *multiply*, il testo sotto resta leggibile |
| **Immagine** | tocca la pagina, poi scegli un PNG o JPEG |
| **Firma** | disegnala col dito, viene ritagliata e resa trasparente |

Il PDF originale non viene mai riscritto: le annotazioni sono sovrapposte, e
salvando si ottiene un file nuovo.

## Limiti

- non modifica il testo già presente nel PDF: un PDF contiene glifi con
  coordinate assolute, non paragrafi, quindi non esiste un vero "reflow";
- il font usato è Helvetica standard: gli accenti funzionano, i caratteri fuori
  dalla codifica WinAnsi (emoji, cirillico, greco) vengono rimossi al
  salvataggio, con avviso;
- niente OCR né compressione;
- i PDF protetti da password non si aprono.

Costruito con [pdf.js](https://mozilla.github.io/pdf.js/) e
[pdf-lib](https://pdf-lib.js.org/).
