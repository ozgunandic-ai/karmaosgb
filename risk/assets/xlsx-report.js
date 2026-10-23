/* KARMA OSGB - tarayıcıda Excel üretimi / okuma.
 * Şablon (data/template.js) bir .xlsx'tir; sayfa XML'i doğrudan düzenlenir, böylece
 * şablonun tüm biçimi (birleşik hücreler, font, renk, kenarlık) birebir korunur.
 * Gereksinim: JSZip (assets/jszip.min.js), window.TEMPLATE_B64
 */
(function (global) {
  "use strict";

  var DATA_FIRST_ROW = 11;
  var COLS = "ABCDEFGHIJKLMNOPQR".split("");
  // Satır 11'deki şablon stil numaraları (A..R) — okunduğu şablondan alınır
  var WRAP_COLS = { 3: 23.66, 4: 25.5, 5: 26.16, 6: 26.33, 7: 27.83, 8: 33.83, 12: 36.66, 13: 24.0, 14: 20.83, 18: 29.33 };

  function trUpper(s) {
    s = (s || "").normalize("NFC").replace(/̇/g, "");
    return s.replace(/i/g, "İ").replace(/ı/g, "I").toUpperCase();
  }

  function xmlEsc(s) {
    return String(s)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function b64ToBytes(b64) {
    var bin = atob(b64), n = bin.length, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var p = String(iso).slice(0, 10).split("-");
    return p.length === 3 ? p[2] + "." + p[1] + "." + p[0] : String(iso);
  }

  function estLines(text, widthChars, fontPt) {
    if (text === null || text === undefined || text === "") return 1;
    var per = Math.max(4, widthChars * (11 / fontPt) * 0.92), lines = 0;
    String(text).split("\n").forEach(function (p) { lines += Math.max(1, Math.ceil(p.length / per)); });
    return lines;
  }

  // ---------- sayfa XML yardımcıları ----------
  function cellRe(ref) { return new RegExp('<c r="' + ref + '"([^>]*?)(?:/>|>[\\s\\S]*?</c>)'); }

  function styleOf(xml, ref) {
    var m = cellRe(ref).exec(xml);
    if (!m) return null;
    var s = /\ss="(\d+)"/.exec(m[1]);
    return s ? s[1] : null;
  }

  function setCell(xml, ref, value, styleOverride) {
    var m = cellRe(ref).exec(xml);
    if (!m) return xml;
    var s = /\ss="(\d+)"/.exec(m[1]);
    var sa = styleOverride ? ' s="' + styleOverride + '"' : (s ? ' s="' + s[1] + '"' : "");
    var out;
    if (value === null || value === undefined || value === "") out = '<c r="' + ref + '"' + sa + "/>";
    else out = '<c r="' + ref + '"' + sa + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(value) + "</t></is></c>";
    return xml.replace(m[0], function () { return out; });
  }

  function setRowHeight(xml, r, ht) {
    return xml.replace(new RegExp('<row r="' + r + '"([^>]*?)\\sht="[\\d.]+"'), function (m, a) {
      return '<row r="' + r + '"' + a + ' ht="' + ht + '"';
    });
  }

  function colWidths(xml) {
    var w = {}, re = /<col\s[^>]*?width="([\d.]+)"[^>]*?min="(\d+)"[^>]*?max="(\d+)"/g, m;
    while ((m = re.exec(xml))) for (var c = +m[2]; c <= +m[3] && c <= 30; c++) w[c] = parseFloat(m[1]);
    return w;
  }

  function rowHeight(xml, r) {
    var m = new RegExp('<row r="' + r + '"[^>]*?\\sht="([\\d.]+)"').exec(xml);
    return m ? parseFloat(m[1]) : 15;
  }

  // ---------- logo ----------
  function loadImage(src) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error("Logo okunamadı")); };
      im.src = src;
    });
  }

  /** Logoyu kutuya (genişlik x yükseklik px) taşırmadan sığdırır; PNG baytları ve görüntü boyutunu döndürür. */
  async function prepareLogo(dataUrl, boxW, boxH) {
    var im = await loadImage(dataUrl), pad = 8;
    var scale = Math.min((boxW - 2 * pad) / im.width, (boxH - 2 * pad) / im.height);
    var outW = Math.max(1, Math.floor(im.width * scale)), outH = Math.max(1, Math.floor(im.height * scale));
    var cw = Math.min(im.width, outW * 2), ch = Math.min(im.height, outH * 2);
    var c = document.createElement("canvas");
    c.width = cw; c.height = ch;
    c.getContext("2d").drawImage(im, 0, 0, cw, ch);
    var blob = await new Promise(function (r) { c.toBlob(r, "image/png"); });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w: outW, h: outH };
  }

  function drawingXml(col, colOff, row, rowOff, w, h) {
    var EMU = 9525, cx = Math.round(w * EMU), cy = Math.round(h * EMU);
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<xdr:oneCellAnchor><xdr:from><xdr:col>' + col + '</xdr:col><xdr:colOff>' + Math.round(colOff * EMU) + '</xdr:colOff><xdr:row>' + row + '</xdr:row><xdr:rowOff>' + Math.round(rowOff * EMU) + '</xdr:rowOff></xdr:from>' +
      '<xdr:ext cx="' + cx + '" cy="' + cy + '"/>' +
      '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
      '<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
      '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>';
  }

  function locate(offset, sizes) {
    for (var i = 0; i < sizes.length; i++) {
      if (offset < sizes[i]) return [i, offset];
      offset -= sizes[i];
    }
    return [sizes.length - 1, 0];
  }

  // ---------- rapor ----------
  /**
   * opts: { info, team, items, logo (dataURL|null), blankRows }
   * items: [[B..R]] 17 alan
   * Dönüş: Blob (.xlsx)
   */
  async function buildReport(opts) {
    var info = opts.info || {}, team = opts.team || {}, items = opts.items || [];
    var zip = await JSZip.loadAsync(b64ToBytes(global.TEMPLATE_B64));
    var sheetPath = "xl/worksheets/sheet1.xml";
    var xml = await zip.file(sheetPath).async("string");

    // ---- başlık alanı ----
    var unvan = trUpper((info.unvan || "").trim());
    xml = setCell(xml, "F1", unvan);                 // font/renk/boyut şablondan (Arial 16 kalın mavi)
    if (unvan.length > 58) xml = setRowHeight(xml, 1, 38 + 16 * Math.ceil((unvan.length - 58) / 58));
    var adres = (info.adres || "").trim(), faal = (info.faaliyet || "").trim();
    xml = setCell(xml, "F2", adres);
    xml = setCell(xml, "F3", faal);
    xml = setRowHeight(xml, 2, Math.max(26, 19 * estLines(adres, 88, 14) + 6));
    xml = setRowHeight(xml, 3, Math.max(26, 19 * estLines(faal, 88, 14) + 6));
    xml = setCell(xml, "M3", info.tehlike || "", styleOf(xml, "N3"));   // N3 ile aynı (ortalı) biçim
    xml = setCell(xml, "N3", fmtDate(info.tarih));
    xml = setCell(xml, "Q3", fmtDate(info.gecerlilik));
    xml = setCell(xml, "A1", null);                  // "LOGO" yazısı kalkar; logo yoksa hücre boş

    // ---- ekip ----
    var names = { E5: team.isveren, G5: team.igu, I5: team.hekim, M5: team.temsilci, P5: team.destek };
    Object.keys(names).forEach(function (k) { xml = setCell(xml, k, (names[k] || "").trim()); });
    if (!(team.temsilci || "").trim()) xml = setCell(xml, "M4", null);   // "Çalışan Temsilcisi" yazısı kalkar
    if (!(team.destek || "").trim()) xml = setCell(xml, "P4", null);     // "Destek Elemanı" yazısı kalkar

    // ---- risk tablosu ----
    var proto = COLS.map(function (c) { return styleOf(xml, c + DATA_FIRST_ROW); });
    var rows = items.slice();
    for (var b = 0; b < (opts.blankRows || 0); b++) rows.push(null);

    var out = [];
    rows.forEach(function (item, idx) {
      var n = idx + 1, r = DATA_FIRST_ROW + idx, has = item && item.some(function (v) { return v !== null && v !== undefined && v !== ""; });
      var cells = "", height = 160;
      var vals = {}; // sütun indeksi (1..18) -> değer
      vals[1] = n;
      if (has) {
        item.forEach(function (v, k) { if (v !== null && v !== undefined && v !== "") vals[k + 2] = v; });
        var need = 1;
        Object.keys(WRAP_COLS).forEach(function (c) { need = Math.max(need, estLines(vals[c], WRAP_COLS[c], 12)); });
        height = Math.max(75, Math.min(409, need * 16 + 12));
      }
      for (var c = 1; c <= 18; c++) {
        var ref = COLS[c - 1] + r, st = proto[c - 1] ? ' s="' + proto[c - 1] + '"' : "", v = vals[c];
        if ((c === 11 || c === 17) && has) {          // RİSK PUANI = Olasılık x Şiddet
          var o = vals[c - 2], s2 = vals[c - 1], O = COLS[c - 3] + r, S = COLS[c - 2] + r;
          if (typeof o === "number" && typeof s2 === "number") {
            cells += '<c r="' + ref + '"' + st + '><f>IF(AND(ISNUMBER(' + O + '),ISNUMBER(' + S + ')),' + O + '*' + S + ',"")</f><v>' + (o * s2) + "</v></c>";
            continue;
          }
        }
        if (v === undefined) cells += '<c r="' + ref + '"' + st + "/>";
        else if (typeof v === "number") cells += '<c r="' + ref + '"' + st + "><v>" + v + "</v></c>";
        else cells += '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + "</t></is></c>";
      }
      out.push('<row r="' + r + '" ht="' + height + '" customHeight="1">' + cells + "</row>");
    });

    var last = DATA_FIRST_ROW + Math.max(rows.length, 1) - 1;
    var a = xml.indexOf('<row r="' + DATA_FIRST_ROW + '"'), z = xml.indexOf("</sheetData>");
    xml = xml.slice(0, a) + out.join("") + xml.slice(z);
    xml = xml.replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:R' + last + '"/>')
      .replace(/ topLeftCell="[^"]*"/, "")
      .replace(/<selection [^>]*\/>/, '<selection activeCell="A1" sqref="A1"/>')
      .replace("<pageSetUpPr/>", '<pageSetUpPr fitToPage="1"/>')
      .replace(/(<pageSetup [^>]*?)\sscale="\d+"/, '$1 fitToWidth="1" fitToHeight="0"');

    // ---- yazdırma alanı ----
    var wb = await zip.file("xl/workbook.xml").async("string");
    wb = wb.replace("<definedNames>", "<definedNames><definedName name=\"_xlnm.Print_Area\" localSheetId=\"0\">'Risk Değerlendirme'!$A$1:$R$" + last + "</definedName>");
    zip.file("xl/workbook.xml", wb);

    // ---- logo ----
    if (opts.logo) {
      try {
        var w = colWidths(xml), colPx = [1, 2, 3, 4].map(function (c) { return Math.floor((w[c] || 8.43) * 7 + 5); });
        var rowPx = [1, 2, 3].map(function (r) { return rowHeight(xml, r) * 96 / 72; });
        var boxW = colPx.reduce(function (p, q) { return p + q; }, 0), boxH = rowPx.reduce(function (p, q) { return p + q; }, 0);
        var lg = await prepareLogo(opts.logo, boxW, boxH);
        var cx = locate((boxW - lg.w) / 2, colPx), cy = locate((boxH - lg.h) / 2, rowPx);
        zip.file("xl/media/logo.png", lg.bytes);
        zip.file("xl/drawings/drawing1.xml", drawingXml(cx[0], cx[1], cy[0], cy[1], lg.w, lg.h));
        zip.file("xl/drawings/_rels/drawing1.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.png"/></Relationships>');
        zip.file("xl/worksheets/_rels/sheet1.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>');
        xml = xml.replace('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
          .replace("</headerFooter>", '</headerFooter><drawing r:id="rId1"/>');
        var ct = await zip.file("[Content_Types].xml").async("string");
        ct = ct.replace("<Default Extension=\"xml\"", '<Default Extension="png" ContentType="image/png"/><Default Extension="xml"')
          .replace("</Types>", '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');
        zip.file("[Content_Types].xml", ct);
      } catch (e) { console.warn("Logo eklenemedi:", e); }
    }

    zip.file(sheetPath, xml);
    return zip.generateAsync({ type: "blob", compression: "DEFLATE", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  // ---------- faaliyet Excel'i okuma ----------
  function colIndex(ref) {
    var m = /^([A-Z]+)/.exec(ref), n = 0;
    for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
    return n;
  }

  function textOf(node) {
    // <si> / <is> içindeki metin; fonetik (rPh) kısımları hariç
    var s = "";
    for (var ch = node.firstChild; ch; ch = ch.nextSibling) {
      if (ch.nodeType !== 1) continue;
      if (ch.localName === "t") s += ch.textContent;
      else if (ch.localName === "r") { for (var t = ch.firstChild; t; t = t.nextSibling) if (t.nodeType === 1 && t.localName === "t") s += t.textContent; }
    }
    return s;
  }

  function serialToDate(n) {
    var d = new Date(Math.round((n - 25569) * 86400000));
    return ("0" + d.getUTCDate()).slice(-2) + "." + ("0" + (d.getUTCMonth() + 1)).slice(-2) + "." + d.getUTCFullYear();
  }

  /** Şablonla aynı düzendeki Excel'den maddeleri okur (B..R). */
  async function parseActivity(arrayBuffer) {
    var zip = await JSZip.loadAsync(arrayBuffer), P = new DOMParser();
    var parse = async function (p) { var f = zip.file(p); return f ? P.parseFromString(await f.async("string"), "application/xml") : null; };

    var wbDoc = await parse("xl/workbook.xml"), relDoc = await parse("xl/_rels/workbook.xml.rels");
    if (!wbDoc || !relDoc) throw new Error("Geçerli bir .xlsx dosyası değil");
    var sheet = wbDoc.getElementsByTagName("sheet")[0], rid = sheet.getAttribute("r:id") || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    var target = "worksheets/sheet1.xml", rels = relDoc.getElementsByTagName("Relationship");
    for (var i = 0; i < rels.length; i++) if (rels[i].getAttribute("Id") === rid) target = rels[i].getAttribute("Target");
    var path = target.charAt(0) === "/" ? target.slice(1) : "xl/" + target;
    var shDoc = await parse(path);
    if (!shDoc) throw new Error("Sayfa okunamadı");

    var ss = [], ssDoc = await parse("xl/sharedStrings.xml");
    if (ssDoc) { var sis = ssDoc.getElementsByTagName("si"); for (var k = 0; k < sis.length; k++) ss.push(textOf(sis[k])); }

    var grid = {}; // satır -> {kol: değer}
    var cells = shDoc.getElementsByTagName("c");
    for (var q = 0; q < cells.length; q++) {
      var c = cells[q], ref = c.getAttribute("r"), t = c.getAttribute("t"), v = null;
      var vEl = c.getElementsByTagName("v")[0];
      if (t === "s") v = vEl ? ss[+vEl.textContent] : null;
      else if (t === "inlineStr") { var is = c.getElementsByTagName("is")[0]; v = is ? textOf(is) : null; }
      else if (t === "str") v = vEl ? vEl.textContent : null;
      else if (t === "b" || t === "e") v = null;
      else if (vEl && vEl.textContent !== "") v = parseFloat(vEl.textContent);
      if (v === null || v === "") continue;
      var row = +/\d+/.exec(ref)[0];
      (grid[row] = grid[row] || {})[colIndex(ref)] = v;
    }

    var start = 11, rowsN = Object.keys(grid).map(Number).sort(function (a, b) { return a - b; });
    for (var x = 0; x < rowsN.length && rowsN[x] < 40; x++) {
      var g = grid[rowsN[x]][9];
      if (typeof g === "string" && g.trim().toUpperCase() === "OLASILIK") { start = rowsN[x] + 1; break; }
    }
    var items = [];
    rowsN.forEach(function (r) {
      if (r < start) return;
      var arr = [];
      for (var c2 = 2; c2 <= 18; c2++) {
        var val = grid[r][c2];
        if (val === undefined) val = null;
        if (typeof val === "string") { val = val.trim(); if (val === "") val = null; }
        if (typeof val === "number" && c2 === 14 && val > 30000 && val < 80000) val = serialToDate(val);
        arr.push(val);
      }
      arr[9] = null; arr[15] = null; // risk puanları çıktıda formülle hesaplanır
      if (arr.some(function (z) { return z !== null; })) items.push(arr);
    });
    return items;
  }

  global.KarmaXlsx = { buildReport: buildReport, parseActivity: parseActivity, trUpper: trUpper };
})(window);
