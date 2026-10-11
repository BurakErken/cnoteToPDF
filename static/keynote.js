/*
 * Keynote (.key) okuyucu
 *
 * .key dosyası tamamen tarayıcıda açılır, sunucuya yüklenmez. Dosya bir ZIP arşividir:
 *   Index/*.iwa -> Snappy ile sıkıştırılmış protobuf nesneleri (slaytlar, stiller, metinler)
 *   Data/*      -> resimler, videolar ve slayt küçük resimleri
 * ZIP'ten sadece gereken parçalar Blob.slice ile okunur; videolar belleğe alınmaz.
 */
(function (global) {
    'use strict';

    const textDecoder = new TextDecoder('utf-8');

    // ------------------------------------------------------------------
    // ZIP reader
    // ------------------------------------------------------------------
    class ZipArchive {
        constructor(blob, entries) {
            this.blob = blob;
            this.entries = entries;
        }

        static async open(blob) {
            const tailSize = Math.min(blob.size, 65557);
            const tail = new Uint8Array(await blob.slice(blob.size - tailSize).arrayBuffer());
            const dv = new DataView(tail.buffer);
            let eocd = -1;
            for (let i = tail.length - 22; i >= 0; i--) {
                if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
            }
            if (eocd < 0) throw new Error('Dosya bir ZIP arşivi değil.');

            let count = dv.getUint16(eocd + 10, true);
            let cdSize = dv.getUint32(eocd + 12, true);
            let cdOffset = dv.getUint32(eocd + 16, true);
            if (cdOffset === 0xFFFFFFFF || count === 0xFFFF) {
                const loc = eocd - 20;
                if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
                    const z64Offset = Number(dv.getBigUint64(loc + 8, true));
                    const z64 = new DataView(await blob.slice(z64Offset, z64Offset + 56).arrayBuffer());
                    count = Number(z64.getBigUint64(32, true));
                    cdSize = Number(z64.getBigUint64(40, true));
                    cdOffset = Number(z64.getBigUint64(48, true));
                }
            }

            const cd = new Uint8Array(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
            const cdv = new DataView(cd.buffer);
            const entries = new Map();
            let p = 0;
            for (let k = 0; k < count && p + 46 <= cd.length; k++) {
                if (cdv.getUint32(p, true) !== 0x02014b50) break;
                const method = cdv.getUint16(p + 10, true);
                let csize = cdv.getUint32(p + 20, true);
                let usize = cdv.getUint32(p + 24, true);
                const nameLen = cdv.getUint16(p + 28, true);
                const extraLen = cdv.getUint16(p + 30, true);
                const commentLen = cdv.getUint16(p + 32, true);
                let offset = cdv.getUint32(p + 42, true);
                const name = textDecoder.decode(cd.subarray(p + 46, p + 46 + nameLen));

                if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || offset === 0xFFFFFFFF) {
                    let e = p + 46 + nameLen;
                    const end = e + extraLen;
                    while (e + 4 <= end) {
                        const id = cdv.getUint16(e, true);
                        const sz = cdv.getUint16(e + 2, true);
                        if (id === 1) {
                            let q = e + 4;
                            if (usize === 0xFFFFFFFF) { usize = Number(cdv.getBigUint64(q, true)); q += 8; }
                            if (csize === 0xFFFFFFFF) { csize = Number(cdv.getBigUint64(q, true)); q += 8; }
                            if (offset === 0xFFFFFFFF) offset = Number(cdv.getBigUint64(q, true));
                        }
                        e += 4 + sz;
                    }
                }

                entries.set(name, { name, method, csize, usize, offset, dataStart: -1 });
                p += 46 + nameLen + extraLen + commentLen;
            }
            return new ZipArchive(blob, entries);
        }

        names() {
            return [...this.entries.keys()];
        }

        async blobOf(name, type) {
            const entry = this.entries.get(name);
            if (!entry) return null;
            if (entry.dataStart < 0) {
                const h = new DataView(await this.blob.slice(entry.offset, entry.offset + 30).arrayBuffer());
                if (h.getUint32(0, true) !== 0x04034b50) throw new Error('Bozuk ZIP girdisi: ' + name);
                entry.dataStart = entry.offset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
            }
            const raw = this.blob.slice(entry.dataStart, entry.dataStart + entry.csize, type || '');
            if (entry.method === 0) return raw;
            if (entry.method === 8) {
                if (typeof DecompressionStream === 'undefined') {
                    throw new Error('Bu tarayıcı sıkıştırılmış ZIP içeriğini açamıyor.');
                }
                const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
                return new Blob([await new Response(stream).arrayBuffer()], { type: type || '' });
            }
            throw new Error('Desteklenmeyen ZIP sıkıştırma yöntemi: ' + entry.method);
        }

        async bytes(name) {
            const blob = await this.blobOf(name);
            return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
        }
    }

    // ------------------------------------------------------------------
    // Snappy + IWA
    // ------------------------------------------------------------------
    function snappyDecompress(src) {
        let p = 0, len = 0, mul = 1, x;
        do { x = src[p++]; len += (x & 0x7f) * mul; mul *= 128; } while (x & 0x80);
        const out = new Uint8Array(len);
        let o = 0;
        while (p < src.length) {
            const tag = src[p++];
            const kind = tag & 3;
            if (kind === 0) {
                let n = tag >>> 2;
                if (n >= 60) {
                    const bytes = n - 59;
                    n = 0;
                    for (let i = 0; i < bytes; i++) n += src[p++] * Math.pow(256, i);
                }
                n += 1;
                out.set(src.subarray(p, p + n), o);
                p += n;
                o += n;
            } else {
                let n, off;
                if (kind === 1) {
                    n = ((tag >>> 2) & 7) + 4;
                    off = ((tag >>> 5) << 8) | src[p++];
                } else if (kind === 2) {
                    n = (tag >>> 2) + 1;
                    off = src[p] | (src[p + 1] << 8);
                    p += 2;
                } else {
                    n = (tag >>> 2) + 1;
                    off = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;
                    p += 4;
                }
                if (off === 0 || off > o) throw new Error('Bozuk Snappy verisi');
                if (off >= n) {
                    out.copyWithin(o, o - off, o - off + n);
                } else {
                    for (let i = 0; i < n; i++) out[o + i] = out[o - off + i];
                }
                o += n;
            }
        }
        return out;
    }

    function iwaDecompress(buf) {
        const parts = [];
        let p = 0, total = 0;
        while (p + 4 <= buf.length) {
            const type = buf[p];
            const len = buf[p + 1] | (buf[p + 2] << 8) | (buf[p + 3] << 16);
            p += 4;
            const chunk = buf.subarray(p, p + len);
            p += len;
            const data = type === 0 ? snappyDecompress(chunk) : chunk;
            parts.push(data);
            total += data.length;
        }
        if (parts.length === 1) return parts[0];
        const out = new Uint8Array(total);
        let o = 0;
        for (const d of parts) { out.set(d, o); o += d.length; }
        return out;
    }

    // ------------------------------------------------------------------
    // Schema-less protobuf message
    // ------------------------------------------------------------------
    class PB {
        constructor(b) {
            this.fields = new Map();
            const len = b.length;
            let p = 0;
            while (p < len) {
                let key = 0, mul = 1, x;
                do { x = b[p++]; key += (x & 0x7f) * mul; mul *= 128; } while ((x & 0x80) && p < len);
                const no = Math.floor(key / 8);
                const wt = key % 8;
                let v;
                if (wt === 0) {
                    v = 0; mul = 1;
                    do { x = b[p++]; v += (x & 0x7f) * mul; mul *= 128; } while ((x & 0x80) && p < len);
                } else if (wt === 1) {
                    v = b.subarray(p, p + 8); p += 8;
                } else if (wt === 2) {
                    let l = 0; mul = 1;
                    do { x = b[p++]; l += (x & 0x7f) * mul; mul *= 128; } while ((x & 0x80) && p < len);
                    v = b.subarray(p, p + l); p += l;
                } else if (wt === 5) {
                    v = b.subarray(p, p + 4); p += 4;
                } else {
                    throw new Error('Geçersiz protobuf verisi');
                }
                if (p > len) throw new Error('Geçersiz protobuf verisi');
                let arr = this.fields.get(no);
                if (!arr) { arr = []; this.fields.set(no, arr); }
                arr.push({ t: wt, v });
            }
        }

        has(no) { return this.fields.has(no); }

        first(no) {
            const arr = this.fields.get(no);
            return arr ? arr[0] : undefined;
        }

        int(no, def) {
            const f = this.first(no);
            return f && f.t === 0 ? f.v : def;
        }

        bool(no, def) {
            const v = this.int(no);
            return v === undefined ? def : v !== 0;
        }

        float(no, def) {
            const f = this.first(no);
            const v = f ? scalarOf(f) : undefined;
            return v === undefined || Number.isNaN(v) ? def : v;
        }

        floats(no) {
            const out = [];
            for (const f of this.fields.get(no) || []) {
                if (f.t === 2) {
                    const dv = new DataView(f.v.buffer, f.v.byteOffset, f.v.byteLength);
                    for (let i = 0; i + 4 <= f.v.length; i += 4) out.push(dv.getFloat32(i, true));
                } else {
                    out.push(scalarOf(f));
                }
            }
            return out;
        }

        ints(no) {
            const out = [];
            for (const f of this.fields.get(no) || []) {
                if (f.t === 0) { out.push(f.v); continue; }
                if (f.t !== 2) continue;
                const b = f.v;
                let p = 0;
                while (p < b.length) {
                    let v = 0, mul = 1, x;
                    do { x = b[p++]; v += (x & 0x7f) * mul; mul *= 128; } while ((x & 0x80) && p < b.length);
                    out.push(v);
                }
            }
            return out;
        }

        str(no, def) {
            const f = this.first(no);
            return f && f.t === 2 ? textDecoder.decode(f.v) : def;
        }

        strs(no) {
            return (this.fields.get(no) || []).filter(f => f.t === 2).map(f => textDecoder.decode(f.v));
        }

        msg(no) {
            const f = this.first(no);
            return f && f.t === 2 ? subMessage(f) : null;
        }

        msgs(no) {
            return (this.fields.get(no) || []).map(subMessage).filter(Boolean);
        }

        ref(no) {
            const m = this.msg(no);
            return m ? m.int(1, null) : null;
        }

        refs(no) {
            return this.msgs(no).map(m => m.int(1, null)).filter(id => id !== null);
        }
    }

    function subMessage(f) {
        if (f.t !== 2) return null;
        if (f.m === undefined) {
            try { f.m = new PB(f.v); } catch (e) { f.m = null; }
        }
        return f.m;
    }

    function scalarOf(f) {
        if (f.t === 5) return new DataView(f.v.buffer, f.v.byteOffset, 4).getFloat32(0, true);
        if (f.t === 1) return new DataView(f.v.buffer, f.v.byteOffset, 8).getFloat64(0, true);
        if (f.t === 0) return f.v;
        return undefined;
    }

    function parseIWA(bytes, into) {
        const data = iwaDecompress(bytes);
        let p = 0;
        while (p < data.length) {
            let len = 0, mul = 1, x;
            do { x = data[p++]; len += (x & 0x7f) * mul; mul *= 128; } while (x & 0x80);
            const info = new PB(data.subarray(p, p + len));
            p += len;
            const id = info.int(1, null);
            let isFirst = true;
            for (const mi of info.msgs(2)) {
                const size = mi.int(3, 0);
                const payload = data.subarray(p, p + size);
                p += size;
                if (isFirst && id !== null && !into.has(id)) {
                    into.set(id, { id, type: mi.int(1, 0), bytes: payload, pb: null });
                }
                isFirst = false;
            }
        }
    }

    // ------------------------------------------------------------------
    // Object types (TSPRegistry ids used by Keynote)
    // ------------------------------------------------------------------
    const T = {
        SHOW: 2,
        SLIDE_NODE: 4,
        SLIDE: 5,
        TEMPLATE_SLIDE: 6,
        PLACEHOLDER: 7,
        SLIDE_STYLE: 9,
        STORAGE: 2001,
        SHAPE_INFO: 2011,
        CHAR_STYLE: 2021,
        PARA_STYLE: 2022,
        LIST_STYLE: 2023,
        TEXT_SHAPE_STYLE: 2025,
        SLIDE_NUMBER: 2043,
        SHAPE: 3004,
        IMAGE: 3005,
        MASK: 3006,
        MOVIE: 3007,
        GROUP: 3008,
        CONNECTION_LINE: 3009,
        SHAPE_STYLE: 3015,
        MEDIA_STYLE: 3016,
        CHART: 5004,
        TABLE: 6000,
        PACKAGE_METADATA: 11006
    };

    const MIME = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp',
        tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp',
        svg: 'image/svg+xml', pdf: 'application/pdf',
        mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', mp3: 'audio/mpeg', m4a: 'audio/mp4',
        aac: 'audio/aac', wav: 'audio/wav'
    };

    // ------------------------------------------------------------------
    // Fonts
    // ------------------------------------------------------------------
    const FONT_FAMILIES = {
        helvetica: ['Helvetica', 'Arimo', 'Arial'],
        helveticaneue: ['Helvetica Neue', 'Helvetica', 'Arimo', 'Arial'],
        arial: ['Arial', 'Arimo', 'Helvetica'],
        timesnewroman: ['Times New Roman', 'Tinos', 'Times'],
        times: ['Times', 'Times New Roman', 'Tinos'],
        calibri: ['Calibri', 'Carlito'],
        cambria: ['Cambria', 'Caladea', 'Georgia'],
        georgia: ['Georgia'],
        verdana: ['Verdana'],
        avenir: ['Avenir', 'Avenir Next', 'Nunito Sans'],
        avenirnext: ['Avenir Next', 'Avenir', 'Nunito Sans'],
        gillsans: ['Gill Sans', 'Gill Sans MT'],
        futura: ['Futura', 'Century Gothic'],
        sfuitext: ['-apple-system', 'Helvetica Neue', 'Segoe UI'],
        sfuidisplay: ['-apple-system', 'Helvetica Neue', 'Segoe UI'],
        sfpro: ['-apple-system', 'Helvetica Neue', 'Segoe UI']
    };

    // Metric-compatible web fonts loaded only when the original is missing.
    const WEB_FALLBACKS = {
        Calibri: 'Carlito', 'Times New Roman': 'Tinos', Times: 'Tinos',
        Arial: 'Arimo', Helvetica: 'Arimo', 'Helvetica Neue': 'Arimo'
    };

    const SERIF_RE = /times|georgia|garamond|baskerville|palatino|didot|bodoni|cochin|hoefler|charter|cambria|caslon|minion|serif|book ?antiqua|rockwell|athelas|iowan|superclarendon|tinos|caladea/i;
    const SYMBOL_FONT_RE = /wingdings|webdings|symbol|zapfdingbats/i;

    const fontCache = new Map();

    function fontFor(psName, bold, italic) {
        const key = psName + '|' + (bold ? 1 : 0) + (italic ? 1 : 0);
        let f = fontCache.get(key);
        if (f) return f;

        const name = (psName || 'Helvetica').replace(/^\./, '');
        const dash = name.indexOf('-');
        const base = dash >= 0 ? name.slice(0, dash) : name;
        const style = (dash >= 0 ? name.slice(dash + 1) : '').toLowerCase().replace(/mt$/, '');
        const baseKey = base.toLowerCase().replace(/(psmt|ps|mt)$/, '');

        let weight = 400;
        if (/black|heavy|extrabold|ultrabold/.test(style)) weight = 800;
        else if (/semibold|demibold|demi/.test(style)) weight = 600;
        else if (/bold/.test(style)) weight = 700;
        else if (/medium/.test(style)) weight = 500;
        else if (/ultralight|extralight|thin|hairline/.test(style)) weight = 200;
        else if (/light/.test(style)) weight = 300;
        if (bold) weight = Math.max(weight, 700);

        const isItalic = !!italic || /italic|oblique|it$/.test(style);
        const families = FONT_FAMILIES[baseKey] ||
            [base.replace(/(PS)?MT$/, '').replace(/([a-z])([A-Z])/g, '$1 $2')];
        const generic = SERIF_RE.test(base) ? 'serif' : 'sans-serif';
        const stack = [name, ...families].map(n => n.startsWith('-') ? n : '"' + n + '"').join(', ') + ', ' + generic;

        f = { stack, weight, italic: isItalic, primary: families[0] };
        fontCache.set(key, f);
        return f;
    }

    function fontCss(font, size) {
        return (font.italic ? 'italic ' : '') + font.weight + ' ' + size + 'px ' + font.stack;
    }

    let probeCtx = null;
    function hasLocalFont(family) {
        if (!probeCtx) probeCtx = document.createElement('canvas').getContext('2d');
        const sample = 'mmmmmmmmmmlliWWW@#şğı';
        return ['monospace', 'serif'].some(g => {
            probeCtx.font = '72px ' + g;
            const w = probeCtx.measureText(sample).width;
            probeCtx.font = '72px "' + family + '", ' + g;
            return probeCtx.measureText(sample).width !== w;
        });
    }

    const metricsCache = new Map();
    // Font metrics as ratios of the font size.
    function fontMetrics(ctx, font) {
        const key = fontCss(font, 100);
        let m = metricsCache.get(key);
        if (m) return m;
        ctx.font = key;
        const tm = ctx.measureText('HgÇğ');
        let ascent = tm.fontBoundingBoxAscent;
        let descent = tm.fontBoundingBoxDescent;
        if (!(ascent > 0)) { ascent = 89; descent = 22; }
        ascent /= 100;
        descent /= 100;
        m = { ascent, descent, line: Math.max(ascent + descent, 1.15) };
        metricsCache.set(key, m);
        return m;
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function colorOf(c) {
        if (!c) return null;
        let r, g, b;
        if (c.has(3) || c.has(4) || c.has(5)) {
            r = c.float(3, 0); g = c.float(4, 0); b = c.float(5, 0);
        } else if (c.has(7) || c.has(10)) {
            const k = c.float(10, 0);
            r = (1 - c.float(7, 0)) * (1 - k);
            g = (1 - c.float(8, 0)) * (1 - k);
            b = (1 - c.float(9, 0)) * (1 - k);
        } else if (c.has(11)) {
            r = g = b = c.float(11, 0);
        } else {
            return null;
        }
        return { r, g, b, a: c.float(6, 1) };
    }

    function cssColor(col, alpha) {
        if (!col) return 'transparent';
        const a = Math.max(0, Math.min(1, col.a * (alpha === undefined ? 1 : alpha)));
        const c = v => Math.round(Math.max(0, Math.min(1, v)) * 255);
        return 'rgba(' + c(col.r) + ',' + c(col.g) + ',' + c(col.b) + ',' + a.toFixed(3) + ')';
    }

    function geometryOf(drawable) {
        const g = drawable ? drawable.msg(1) : null;
        if (!g) return { x: 0, y: 0, w: 0, h: 0, angle: 0 };
        const pos = g.msg(1), size = g.msg(2);
        return {
            x: pos ? pos.float(1, 0) : 0,
            y: pos ? pos.float(2, 0) : 0,
            w: size ? size.float(1, 0) : 0,
            h: size ? size.float(2, 0) : 0,
            angle: g.float(4, 0)
        };
    }

    function tableEntries(table) {
        if (!table) return [];
        return table.msgs(1).map(e => ({ i: e.int(1, 0), ref: e.ref(2), level: e.int(2, 0) }));
    }

    function entryAt(entries, index) {
        let found;
        for (const e of entries) {
            if (e.i <= index) found = e;
            else break;
        }
        return found;
    }

    function pick(arr, level, def) {
        return arr && arr.length ? arr[Math.min(level, arr.length - 1)] : def;
    }

    function roman(n) {
        const table = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
            [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
        let out = '';
        for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
        return out;
    }

    function alpha(n) {
        let out = '';
        while (n > 0) { n--; out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26); }
        return out;
    }

    function formatNumber(n, type) {
        const group = Math.floor(type / 3);
        const style = type % 3;
        let s;
        if (group === 1) s = roman(n);
        else if (group === 2) s = roman(n).toLowerCase();
        else if (group === 3) s = alpha(n);
        else if (group === 4) s = alpha(n).toLowerCase();
        else s = String(n);
        return style === 1 ? '(' + s + ')' : style === 2 ? s + ')' : s + '.';
    }

    const WINGDINGS = { v: '❖', 'Ø': '➢', 'ü': '✔', q: '❑', n: '■', l: '●', '§': '▪', 'w': '◆', 'à': '➔', 'è': '➜', 'Ü': '✓' };

    // Affine matrix [a, b, c, d, e, f]
    function matMul(m, n) {
        return [
            m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
            m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
            m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
        ];
    }

    // Matrix that maps a drawable's local frame (0..w, 0..h) into its parent's space.
    function frameMatrix(g) {
        const rad = -(g.angle || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const cx = g.x + g.w / 2, cy = g.y + g.h / 2;
        return matMul([cos, sin, -sin, cos, cx, cy], [1, 0, 0, 1, -g.w / 2, -g.h / 2]);
    }

    function transformPath(cmds, m) {
        const out = [];
        for (const c of cmds) {
            const r = [c[0]];
            for (let i = 1; i < c.length; i += 2) {
                r.push(m[0] * c[i] + m[2] * c[i + 1] + m[4], m[1] * c[i] + m[3] * c[i + 1] + m[5]);
            }
            out.push(r);
        }
        return out;
    }

    function toPath2D(cmds) {
        const p = new Path2D();
        for (const c of cmds) {
            switch (c[0]) {
                case 'M': p.moveTo(c[1], c[2]); break;
                case 'L': p.lineTo(c[1], c[2]); break;
                case 'Q': p.quadraticCurveTo(c[1], c[2], c[3], c[4]); break;
                case 'C': p.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]); break;
                case 'Z': p.closePath(); break;
            }
        }
        return p;
    }

    function rectPath(w, h) {
        return [['M', 0, 0], ['L', w, 0], ['L', w, h], ['L', 0, h], ['Z']];
    }

    function roundedRectPath(w, h, rx, ry) {
        rx = Math.max(0, Math.min(rx, w / 2));
        ry = Math.max(0, Math.min(ry, h / 2));
        if (!rx || !ry) return rectPath(w, h);
        const k = 0.5523;
        return [
            ['M', rx, 0], ['L', w - rx, 0], ['C', w - rx + rx * k, 0, w, ry - ry * k, w, ry],
            ['L', w, h - ry], ['C', w, h - ry + ry * k, w - rx + rx * k, h, w - rx, h],
            ['L', rx, h], ['C', rx - rx * k, h, 0, h - ry + ry * k, 0, h - ry],
            ['L', 0, ry], ['C', 0, ry - ry * k, rx - rx * k, 0, rx, 0], ['Z']
        ];
    }

    function polygonPath(cx, cy, rx, ry, n, innerRatio) {
        const cmds = [];
        const count = innerRatio ? n * 2 : n;
        for (let i = 0; i < count; i++) {
            const a = -Math.PI / 2 + i * 2 * Math.PI / count;
            const r = innerRatio && i % 2 ? innerRatio : 1;
            cmds.push([i ? 'L' : 'M', cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
        }
        cmds.push(['Z']);
        return cmds;
    }

    // Converts a TSD.PathSourceArchive into path commands in the frame (0..w, 0..h).
    function pathFromSource(ps, w, h) {
        if (!ps) return rectPath(w, h);
        let cmds = null;

        const bezier = ps.msg(5) || (ps.msg(7) && ps.msg(7).msg(1));
        if (bezier) {
            const ns = bezier.msg(2);
            const nw = ns ? ns.float(1, 0) : 0, nh = ns ? ns.float(2, 0) : 0;
            const sx = nw > 0.0001 ? w / nw : 1, sy = nh > 0.0001 ? h / nh : 1;
            const path = bezier.msg(3);
            cmds = [];
            for (const el of path ? path.msgs(1) : []) {
                const type = el.int(1, 0);
                const pts = el.msgs(2).map(p => [p.float(1, 0) * sx, p.float(2, 0) * sy]);
                if (type === 1 && pts[0]) cmds.push(['M', pts[0][0], pts[0][1]]);
                else if (type === 2 && pts[0]) cmds.push(['L', pts[0][0], pts[0][1]]);
                else if (type === 3 && pts.length >= 2) cmds.push(['Q', pts[0][0], pts[0][1], pts[1][0], pts[1][1]]);
                else if (type === 4 && pts.length >= 3) cmds.push(['C', pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[2][0], pts[2][1]]);
                else if (type === 5) cmds.push(['Z']);
            }
        } else if (ps.has(4)) {
            const sc = ps.msg(4);
            const type = sc.int(1, 0);
            const value = sc.float(2, 0);
            const ns = sc.msg(3);
            const nw = ns ? ns.float(1, w) : w, nh = ns ? ns.float(2, h) : h;
            const sx = nw > 0.0001 ? w / nw : 1, sy = nh > 0.0001 ? h / nh : 1;
            if (type === 0) {
                const r = Math.min(value, nw / 2, nh / 2);
                cmds = roundedRectPath(w, h, r * sx, r * sy);
            } else if (type === 1) {
                cmds = polygonPath(w / 2, h / 2, w / 2, h / 2, Math.max(3, Math.round(value)));
            } else if (type === 2) {
                const d = Math.min(value * sx, w / 2);
                cmds = [['M', 0, 0], ['L', w - d, 0], ['L', w, h / 2], ['L', w - d, h], ['L', 0, h], ['L', d, h / 2], ['Z']];
            }
        } else if (ps.has(3)) {
            const pt = ps.msg(3);
            const type = pt.int(1, 0);
            const point = pt.msg(2);
            const ns = pt.msg(3);
            const nw = ns ? ns.float(1, w) : w, nh = ns ? ns.float(2, h) : h;
            const px = point ? point.float(1, 0) * (nw ? w / nw : 1) : w * 0.3;
            const py = point ? point.float(2, 0) * (nh ? h / nh : 1) : h * 0.25;
            if (type === 100) {
                const n = Math.max(3, Math.round(point ? point.float(2, 5) : 5));
                cmds = polygonPath(w / 2, h / 2, w / 2, h / 2, n, point ? Math.max(0.1, Math.min(1, point.float(1, 0.5))) : 0.5);
            } else if (type === 200) {
                const t = Math.min(px, w / 2), u = Math.min(py, h / 2);
                cmds = [['M', t, 0], ['L', w - t, 0], ['L', w - t, u], ['L', w, u], ['L', w, h - u], ['L', w - t, h - u],
                    ['L', w - t, h], ['L', t, h], ['L', t, h - u], ['L', 0, h - u], ['L', 0, u], ['L', t, u], ['Z']];
            } else {
                const head = Math.min(px, w / 2), shaft = Math.max(0, Math.min(py, h / 2));
                const right = [['M', 0, shaft], ['L', w - head, shaft], ['L', w - head, 0], ['L', w, h / 2],
                    ['L', w - head, h], ['L', w - head, h - shaft], ['L', 0, h - shaft], ['Z']];
                if (type === 0) cmds = transformPath(right, [-1, 0, 0, 1, w, 0]);
                else if (type === 10) {
                    cmds = [['M', 0, h / 2], ['L', head, 0], ['L', head, shaft], ['L', w - head, shaft], ['L', w - head, 0],
                        ['L', w, h / 2], ['L', w - head, h], ['L', w - head, h - shaft], ['L', head, h - shaft], ['L', head, h], ['Z']];
                } else cmds = right;
            }
        } else if (ps.has(6)) {
            const co = ps.msg(6);
            const ns = co.msg(1);
            const nw = ns ? ns.float(1, w) : w, nh = ns ? ns.float(2, h) : h;
            const r = co.float(4, 0);
            cmds = roundedRectPath(w, h, r * (nw ? w / nw : 1), r * (nh ? h / nh : 1));
        } else if (ps.has(8)) {
            const eb = ps.msg(8);
            const ns = eb.msg(2);
            const nw = ns ? ns.float(1, w) : w, nh = ns ? ns.float(2, h) : h;
            const sx = nw ? w / nw : 1, sy = nh ? h / nh : 1;
            const pt = m => m ? [m.float(1, 0) * sx, m.float(2, 0) * sy] : null;
            cmds = [];
            for (const sp of eb.msgs(1)) {
                const nodes = sp.msgs(1).map(n => ({ inC: pt(n.msg(1)), p: pt(n.msg(2)), outC: pt(n.msg(3)) })).filter(n => n.p);
                if (!nodes.length) continue;
                cmds.push(['M', nodes[0].p[0], nodes[0].p[1]]);
                const seg = (a, b) => {
                    const c1 = a.outC || a.p, c2 = b.inC || b.p;
                    cmds.push(['C', c1[0], c1[1], c2[0], c2[1], b.p[0], b.p[1]]);
                };
                for (let i = 1; i < nodes.length; i++) seg(nodes[i - 1], nodes[i]);
                if (sp.bool(2, false)) { seg(nodes[nodes.length - 1], nodes[0]); cmds.push(['Z']); }
            }
        }

        if (!cmds || !cmds.length) cmds = rectPath(w, h);
        const hflip = ps.bool(1, false), vflip = ps.bool(2, false);
        if (hflip || vflip) cmds = transformPath(cmds, [hflip ? -1 : 1, 0, 0, vflip ? -1 : 1, hflip ? w : 0, vflip ? h : 0]);
        return cmds;
    }

    // ------------------------------------------------------------------
    // Document
    // ------------------------------------------------------------------
    class KeynoteDocument {
        constructor(zip, prefix, objects) {
            this.zip = zip;
            this.prefix = prefix;
            this.objects = objects;
            this.dataFiles = new Map();
            this.slides = [];
            this.width = 1024;
            this.height = 768;
            this.onChange = null;
            this.urls = new Map();
            this.images = new Map();
            this.slideCache = new Map();
            this.lookupCache = new Map();
            this.changeScheduled = false;
        }

        static async open(file) {
            const outer = await ZipArchive.open(file);
            const names = outer.names();
            let zip = outer, indexZip = outer, prefix = '', indexPrefix = '';

            const docName = names.find(n => /(^|\/)Index\/Document\.iwa$/.test(n));
            if (docName) {
                prefix = indexPrefix = docName.slice(0, -'Index/Document.iwa'.length);
            } else {
                const nested = names.find(n => /(^|\/)Index\.zip$/.test(n));
                if (nested) {
                    prefix = nested.slice(0, -'Index.zip'.length);
                    indexZip = await ZipArchive.open(await outer.blobOf(nested));
                } else if (names.some(n => /(^|\/)index\.apxl(\.gz)?$/.test(n))) {
                    throw new Error('Bu .key dosyası eski Keynote \'09 biçiminde. Keynote ile açıp yeniden kaydederseniz görüntülenebilir.');
                } else {
                    throw new Error('Bu dosya geçerli bir Keynote sunumu değil.');
                }
            }

            const iwaNames = indexZip.names().filter(n => n.startsWith(indexPrefix + 'Index/') && n.endsWith('.iwa'));
            const buffers = await Promise.all(iwaNames.map(n => indexZip.bytes(n)));
            const objects = new Map();
            buffers.forEach((buf, i) => {
                try { parseIWA(buf, objects); } catch (e) { console.warn('IWA okunamadı:', iwaNames[i], e); }
            });

            const doc = new KeynoteDocument(zip, prefix, objects);
            doc.readMetadata(names);
            doc.readShow();
            if (!doc.slides.length) throw new Error('Sunumda slayt bulunamadı.');
            doc.loadFallbackFonts();
            return doc;
        }

        obj(id) {
            if (id === null || id === undefined) return null;
            const o = this.objects.get(id);
            if (!o) return null;
            if (!o.pb) {
                try { o.pb = new PB(o.bytes); } catch (e) { o.pb = new PB(new Uint8Array(0)); }
            }
            return o;
        }

        ofType(type) {
            for (const o of this.objects.values()) if (o.type === type) return this.obj(o.id);
            return null;
        }

        readMetadata(names) {
            const meta = this.ofType(T.PACKAGE_METADATA);
            if (meta) {
                for (const d of meta.pb.msgs(4)) {
                    const id = d.int(1, null);
                    const file = d.str(4) || d.str(3);
                    if (id !== null && file) this.dataFiles.set(id, file);
                }
            }
            // Fallback: data files are named "<name>-<id>.<ext>"
            const dataPrefix = this.prefix + 'Data/';
            for (const n of names) {
                if (!n.startsWith(dataPrefix)) continue;
                const file = n.slice(dataPrefix.length);
                const m = /-(\d+)\.[^.]+$/.exec(file);
                if (m && !this.dataFiles.has(+m[1])) this.dataFiles.set(+m[1], file);
            }
        }

        readShow() {
            const show = this.ofType(T.SHOW);
            if (!show) throw new Error('Sunum yapısı okunamadı.');
            const size = show.pb.msg(4);
            if (size) {
                this.width = size.float(1, 1024) || 1024;
                this.height = size.float(2, 768) || 768;
            }
            const tree = show.pb.msg(3);
            const seen = new Set();
            const visit = nodeId => {
                if (seen.has(nodeId)) return;
                seen.add(nodeId);
                const node = this.obj(nodeId);
                if (!node || node.type !== T.SLIDE_NODE) return;
                const slideId = node.pb.ref(2);
                if (slideId !== null && this.obj(slideId)) {
                    this.slides.push({ slideId, thumbId: node.pb.ref(16) });
                }
                node.pb.refs(1).forEach(visit);
            };
            if (tree) tree.refs(2).forEach(visit);
            if (!this.slides.length) {
                for (const o of this.objects.values()) if (o.type === T.SLIDE_NODE) visit(o.id);
            }
        }

        loadFallbackFonts() {
            if (!document.fonts || !document.fonts.load) return;
            const needed = new Set();
            for (const o of this.objects.values()) {
                if (o.type !== T.CHAR_STYLE && o.type !== T.PARA_STYLE) continue;
                const props = this.obj(o.id).pb.msg(11);
                const name = props && props.str(5);
                if (!name) continue;
                const font = fontFor(name, false, false);
                const web = WEB_FALLBACKS[font.primary];
                if (web) needed.add(font.primary);
            }
            const loads = [];
            for (const family of needed) {
                if (hasLocalFont(family)) continue;
                const web = WEB_FALLBACKS[family];
                for (const variant of ['400', '700', 'italic 400', 'italic 700']) {
                    loads.push(document.fonts.load(variant + ' 16px "' + web + '"').catch(() => null));
                }
            }
            if (loads.length) Promise.all(loads).then(() => { metricsCache.clear(); this.changed(); });
        }

        changed() {
            if (this.changeScheduled) return;
            this.changeScheduled = true;
            requestAnimationFrame(() => {
                this.changeScheduled = false;
                if (this.onChange) this.onChange();
            });
        }

        dispose() {
            for (const url of this.urls.values()) {
                if (typeof url === 'string') URL.revokeObjectURL(url);
            }
            this.urls.clear();
            this.images.clear();
            this.onChange = null;
        }

        // ---------------- Media ----------------
        async mediaURL(dataId) {
            if (dataId === null || dataId === undefined) return null;
            if (this.urls.has(dataId)) return this.urls.get(dataId);
            const file = this.dataFiles.get(dataId);
            if (!file) return null;
            const ext = (file.split('.').pop() || '').toLowerCase();
            const blob = await this.zip.blobOf(this.prefix + 'Data/' + file, MIME[ext] || '');
            const url = blob ? URL.createObjectURL(blob) : null;
            this.urls.set(dataId, url);
            return url;
        }

        mediaName(dataId) {
            return this.dataFiles.get(dataId) || '';
        }

        // Returns a decoded image for the first source that loads, or null while loading.
        image(sources) {
            const key = sources.join(',');
            let entry = this.images.get(key);
            if (!entry) {
                entry = { img: null, state: 'loading' };
                this.images.set(key, entry);
                const tryNext = async i => {
                    if (i >= sources.length) { entry.state = 'error'; this.changed(); return; }
                    const file = this.dataFiles.get(sources[i]) || '';
                    if (/\.pdf$/i.test(file)) return tryNext(i + 1);
                    let url = null;
                    try { url = await this.mediaURL(sources[i]); } catch (e) { url = null; }
                    if (!url) return tryNext(i + 1);
                    const img = new Image();
                    img.onload = () => { entry.img = img; entry.state = 'ready'; this.changed(); };
                    img.onerror = () => tryNext(i + 1);
                    img.src = url;
                };
                tryNext(0);
            }
            return entry.state === 'ready' ? entry.img : null;
        }

        async thumbnailURL(index) {
            const s = this.slides[index];
            return s && s.thumbId !== null ? this.mediaURL(s.thumbId) : null;
        }

        // ---------------- Styles ----------------
        styleParent(o) {
            const base = o.type === T.TEXT_SHAPE_STYLE ? (o.pb.msg(1) && o.pb.msg(1).msg(1)) : o.pb.msg(1);
            return base ? base.ref(3) : null;
        }

        // Walks a style's parent chain and returns the first value `get` finds.
        lookup(styleId, propsOf, get) {
            let id = styleId, guard = 0;
            while (id !== null && id !== undefined && guard++ < 40) {
                const o = this.obj(id);
                if (!o) return undefined;
                const props = propsOf(o);
                if (props) {
                    const v = get(props);
                    if (v !== undefined) return v;
                }
                id = this.styleParent(o);
            }
            return undefined;
        }

        cached(key, fn) {
            if (this.lookupCache.has(key)) return this.lookupCache.get(key);
            const v = fn();
            this.lookupCache.set(key, v);
            return v;
        }

        parseFill(f) {
            if (!f) return null;
            if (f.has(1)) {
                const color = colorOf(f.msg(1));
                return color ? { type: 'color', color } : null;
            }
            if (f.has(2)) {
                const g = f.msg(2);
                const stops = g.msgs(2)
                    .map(s => ({ color: colorOf(s.msg(1)), t: Math.max(0, Math.min(1, s.float(2, 0))) }))
                    .filter(s => s.color)
                    .sort((a, b) => a.t - b.t);
                if (!stops.length) return null;
                const tg = g.msg(6);
                return {
                    type: 'gradient',
                    radial: g.int(1, 0) === 1,
                    stops,
                    opacity: g.float(3, 1),
                    angle: g.msg(5) ? g.msg(5).float(2, 0) : 0,
                    transform: tg && tg.msg(1) && tg.msg(2) ? {
                        start: [tg.msg(1).float(1, 0), tg.msg(1).float(2, 0)],
                        end: [tg.msg(2).float(1, 0), tg.msg(2).float(2, 0)],
                        size: tg.msg(3) ? [tg.msg(3).float(1, 0), tg.msg(3).float(2, 0)] : null
                    } : null
                };
            }
            if (f.has(3)) {
                const im = f.msg(3);
                const dataId = im.ref(6) !== null ? im.ref(6) : im.ref(7);
                return dataId === null ? null : { type: 'image', dataId, technique: im.int(2, 3) };
            }
            return null;
        }

        parseStroke(s) {
            if (!s) return null;
            const color = colorOf(s.msg(1));
            const pattern = s.msg(6);
            const ptype = pattern ? pattern.int(1, 1) : 1;
            if (!color || ptype === 2) return null;
            const width = s.float(2, 1);
            if (!(width > 0)) return null;
            let dash = null;
            if (ptype === 0 && pattern) {
                const count = pattern.int(3, 0);
                const els = pattern.floats(4).slice(0, count);
                if (els.length && els.some(v => v > 0)) dash = els.map(v => Math.max(v, 0.01) * width);
            }
            return {
                color, width, dash,
                cap: ['butt', 'round', 'square'][s.int(3, 0)] || 'butt',
                join: ['miter', 'round', 'bevel'][s.int(4, 0)] || 'miter'
            };
        }

        parseShadow(sh) {
            if (!sh || !sh.bool(6, true) || sh.int(7, 0) !== 0) return null;
            const color = colorOf(sh.msg(1));
            if (!color) return null;
            return { color, angle: sh.float(2, 315), offset: sh.float(3, 5), radius: sh.float(4, 1), opacity: sh.float(5, 1) };
        }

        shapeStyle(styleId) {
            return this.cached('shape:' + styleId, () => {
                const tsd = o => o.type === T.TEXT_SHAPE_STYLE ? (o.pb.msg(1) && o.pb.msg(1).msg(11)) :
                    o.type === T.SHAPE_STYLE ? o.pb.msg(11) : null;
                const fillMsg = this.lookup(styleId, tsd, p => p.has(1) ? p.msg(1) : undefined);
                const strokeMsg = this.lookup(styleId, tsd, p => p.has(2) ? p.msg(2) : undefined);
                const opacity = this.lookup(styleId, tsd, p => p.has(3) ? p.float(3) : undefined);
                const shadowMsg = this.lookup(styleId, tsd, p => p.has(4) ? p.msg(4) : undefined);
                return {
                    fill: this.parseFill(fillMsg),
                    stroke: this.parseStroke(strokeMsg),
                    opacity: opacity === undefined ? 1 : opacity,
                    shadow: this.parseShadow(shadowMsg)
                };
            });
        }

        mediaStyle(styleId) {
            return this.cached('media:' + styleId, () => {
                const props = o => o.type === T.MEDIA_STYLE ? o.pb.msg(11) : null;
                const strokeMsg = this.lookup(styleId, props, p => p.has(1) ? p.msg(1) : undefined);
                const opacity = this.lookup(styleId, props, p => p.has(2) ? p.float(2) : undefined);
                const shadowMsg = this.lookup(styleId, props, p => p.has(3) ? p.msg(3) : undefined);
                return {
                    stroke: this.parseStroke(strokeMsg),
                    opacity: opacity === undefined ? 1 : opacity,
                    shadow: this.parseShadow(shadowMsg)
                };
            });
        }

        textBoxStyle(styleId) {
            return this.cached('textbox:' + styleId, () => {
                const tswp = o => o.type === T.TEXT_SHAPE_STYLE ? o.pb.msg(11) : null;
                const get = (fn, def) => {
                    const v = this.lookup(styleId, tswp, fn);
                    return v === undefined ? def : v;
                };
                return {
                    shrink: get(p => p.has(1) ? p.bool(1) : undefined, false),
                    valign: get(p => p.has(2) ? p.int(2) : undefined, 0),
                    insets: get(p => {
                        const m = p.msg(6);
                        return m ? { l: m.float(1, 0), t: m.float(2, 0), r: m.float(3, 0), b: m.float(4, 0) } : undefined;
                    }, { l: 4, t: 4, r: 4, b: 4 }),
                    defaultPara: get(p => p.has(10) ? p.ref(10) : undefined, null)
                };
            });
        }

        charProps(charStyleId, paraStyleId) {
            return this.cached('char:' + charStyleId + ':' + paraStyleId, () => {
                const propsOf = o => (o.type === T.CHAR_STYLE || o.type === T.PARA_STYLE) ? o.pb.msg(11) : null;
                const get = (fn, def) => {
                    let v = charStyleId !== null ? this.lookup(charStyleId, propsOf, fn) : undefined;
                    if (v === undefined && paraStyleId !== null) v = this.lookup(paraStyleId, propsOf, fn);
                    return v === undefined ? def : v;
                };
                const color = get(p => {
                    if (p.has(7)) return colorOf(p.msg(7)) || undefined;
                    const fill = p.msg(46);
                    return fill && fill.has(1) ? colorOf(fill.msg(1)) || undefined : undefined;
                }, { r: 0, g: 0, b: 0, a: 1 });
                const name = get(p => p.has(5) ? p.str(5) : undefined, 'HelveticaNeue');
                const bold = get(p => p.has(1) ? p.bool(1) : undefined, false);
                const italic = get(p => p.has(2) ? p.bool(2) : undefined, false);
                return {
                    font: fontFor(name, bold, italic),
                    size: Math.max(1, get(p => p.has(3) ? p.float(3) : undefined, 18)),
                    color,
                    underline: get(p => p.has(11) ? p.int(11) : undefined, 0) > 0
                };
            });
        }

        paraProps(styleId) {
            return this.cached('para:' + styleId, () => {
                const propsOf = o => o.type === T.PARA_STYLE ? o.pb.msg(12) : null;
                const get = (fn, def) => {
                    const v = styleId !== null ? this.lookup(styleId, propsOf, fn) : undefined;
                    return v === undefined ? def : v;
                };
                const f = no => p => p.has(no) ? p.float(no) : undefined;
                return {
                    align: get(p => p.has(1) ? p.int(1) : undefined, 4),
                    firstIndent: get(f(7), 0),
                    leftIndent: get(f(11), 0),
                    rightIndent: get(f(19), 0),
                    spaceAfter: get(f(20), 0),
                    spaceBefore: get(f(21), 0),
                    spacing: get(p => {
                        const s = p.msg(13);
                        return s && (s.has(1) || s.has(2)) ? { mode: s.int(1, 0), amount: s.float(2, 1) } : undefined;
                    }, { mode: 0, amount: 1 }),
                    listStyle: get(p => p.has(40) ? p.ref(40) : undefined, null)
                };
            });
        }

        listArray(listId, field, kind) {
            let id = listId, guard = 0;
            while (id !== null && guard++ < 40) {
                const o = this.obj(id);
                if (!o || o.type !== T.LIST_STYLE) return [];
                const arr = o.pb[kind](field);
                if (arr.length) return arr;
                id = this.styleParent(o);
            }
            return [];
        }

        listLabel(listId, level, props, counters) {
            if (listId === null || listId === undefined) return null;
            const type = pick(this.listArray(listId, 11, 'ints'), level, 0);
            const label = {
                type,
                indent: pick(this.listArray(listId, 13, 'floats'), level, 0),
                textIndentEm: pick(this.listArray(listId, 12, 'floats'), level, 0)
            };
            if (type !== 3) counters.length = Math.min(counters.length, level);
            if (type === 0) return label;

            const geo = pick(this.listArray(listId, 14, 'msgs'), level, null);
            const scale = geo ? geo.float(1, 1) || 1 : 1;
            const labelColors = this.listArray(listId, 21, 'msgs');
            const color = (labelColors.length && colorOf(pick(labelColors, level, null))) || props.color;
            const fontName = pick(this.listArray(listId, 23, 'strs'), level, '');
            const symbolFont = SYMBOL_FONT_RE.test(fontName);

            label.size = props.size * scale;
            label.color = color;
            label.font = fontName && !symbolFont ? fontFor(fontName, false, false) : props.font;

            if (type === 2) {
                let text = pick(this.listArray(listId, 16, 'strs'), level, '•') || '•';
                if (symbolFont) text = [...text].map(ch => WINGDINGS[ch] || (ch.charCodeAt(0) >= 0xF000 ? '•' : ch)).join('');
                label.text = text;
            } else if (type === 3) {
                counters.length = Math.min(counters.length, level + 1);
                counters[level] = (counters[level] || 0) + 1;
                label.text = formatNumber(counters[level], pick(this.listArray(listId, 15, 'ints'), level, 0));
            } else if (type === 1) {
                const img = pick(this.listArray(listId, 17, 'msgs'), level, null);
                label.imageId = img ? (img.ref(3) !== null ? img.ref(3) : img.ref(1)) : null;
                if (label.imageId === null) label.text = '•';
            }
            return label;
        }

        // ---------------- Text ----------------
        buildText(storageId, shapeStyleId, slideNumber) {
            const st = this.obj(storageId);
            if (!st || st.type !== T.STORAGE) return null;
            const pb = st.pb;
            const raw = pb.strs(3).join('');
            if (!raw || !raw.replace(/[\s\u2028\u2029]/g, '')) return null;

            const tParaStyle = tableEntries(pb.msg(5));
            const tParaData = tableEntries(pb.msg(6));
            const tList = tableEntries(pb.msg(7));
            const tChar = tableEntries(pb.msg(8));
            const tAttach = tableEntries(pb.msg(9));
            const box = this.textBoxStyle(shapeStyleId);

            const substitute = (text, offset) => text
                .replace(/\u00AD/g, '')
                .replace(/\uFFFC/g, (m, i) => {
                    const e = entryAt(tAttach, offset + i);
                    const att = e && e.i === offset + i ? this.obj(e.ref) : null;
                    return att && att.type === T.SLIDE_NUMBER ? String(slideNumber) : '';
                });

            const paragraphs = [];
            const counters = [];
            let start = 0;
            let lastParaStyle = box.defaultPara;
            for (let i = 0; i <= raw.length; i++) {
                if (i < raw.length && raw[i] !== '\n' && raw[i] !== '\u2029') continue;
                const end = i;
                // An empty paragraph-style entry continues the previous paragraph's style.
                const pe = entryAt(tParaStyle, start);
                const paraStyle = pe && pe.ref !== null ? pe.ref : lastParaStyle;
                lastParaStyle = paraStyle;
                const pp = this.paraProps(paraStyle);
                const levelEntry = entryAt(tParaData, start);
                const level = levelEntry ? levelEntry.level : 0;
                const le = entryAt(tList, start);
                const listStyle = le && le.ref !== null ? le.ref : pp.listStyle;

                const bounds = [start];
                for (const e of tChar) if (e.i > start && e.i < end) bounds.push(e.i);
                bounds.push(end);
                const runs = [];
                for (let b = 0; b < bounds.length - 1; b++) {
                    const a = bounds[b], z = bounds[b + 1];
                    if (z <= a) continue;
                    const ce = entryAt(tChar, a);
                    const props = this.charProps(ce ? ce.ref : null, paraStyle);
                    const text = substitute(raw.slice(a, z), a);
                    if (text) runs.push(Object.assign({ text }, props));
                }
                const ce0 = entryAt(tChar, start);
                const base = this.charProps(ce0 ? ce0.ref : null, paraStyle);
                // Keynote shows no bullet or number on an empty paragraph.
                const isEmpty = !runs.some(r => r.text.trim());
                const label = isEmpty ? null : this.listLabel(listStyle, level, runs[0] || base, counters);
                paragraphs.push(Object.assign({ runs, base, label }, pp));
                start = i + 1;
            }
            return { paragraphs, shrink: box.shrink, valign: box.valign, insets: box.insets };
        }

        // ---------------- Drawables ----------------
        buildDrawable(id, ctx, depth) {
            const o = this.obj(id);
            if (!o || depth > 24) return null;
            try {
                switch (o.type) {
                    case T.SHAPE_INFO:
                    case T.PLACEHOLDER:
                    case T.SHAPE:
                    case T.CONNECTION_LINE:
                        return this.buildShape(o, ctx);
                    case T.IMAGE:
                        return this.buildImage(o);
                    case T.MOVIE:
                        return this.buildMovie(o);
                    case T.GROUP:
                        return this.buildGroup(o, ctx, depth);
                    case T.TABLE:
                        return this.buildUnsupported(o, 'Tablo');
                    case T.CHART:
                        return this.buildUnsupported(o, 'Grafik');
                    default:
                        return null;
                }
            } catch (e) {
                console.warn('Nesne çizilemedi:', id, o.type, e);
                return null;
            }
        }

        buildShape(o, ctx) {
            let info = null, shape = null;
            if (o.type === T.PLACEHOLDER) {
                info = o.pb.msg(1);
                shape = info && info.msg(1);
            } else if (o.type === T.SHAPE_INFO) {
                info = o.pb;
                shape = o.pb.msg(1);
            } else if (o.type === T.CONNECTION_LINE) {
                shape = o.pb.msg(1);
            } else {
                shape = o.pb;
            }
            if (!shape) return null;

            let geo = geometryOf(shape.msg(1));
            if (o.type === T.PLACEHOLDER && !geo.w && !geo.h && ctx.template) {
                const tp = this.templatePlaceholder(ctx.template, o.pb.int(2, -1));
                if (tp) geo = tp;
            }
            const styleId = shape.ref(2);
            const style = this.shapeStyle(styleId);
            let text = null;
            if (info) {
                const storageId = info.ref(4) !== null ? info.ref(4) : info.ref(2);
                if (storageId !== null) text = this.buildText(storageId, styleId, ctx.slideNumber);
            }
            return {
                kind: 'shape',
                geo,
                path: pathFromSource(shape.msg(3), geo.w, geo.h),
                fill: style.fill,
                stroke: style.stroke,
                opacity: style.opacity,
                shadow: style.shadow,
                text
            };
        }

        templatePlaceholder(templateId, kind) {
            const t = this.obj(templateId);
            if (!t) return null;
            for (const id of t.pb.refs(7)) {
                const p = this.obj(id);
                if (p && p.type === T.PLACEHOLDER && p.pb.int(2, -2) === kind) {
                    const info = p.pb.msg(1);
                    return info && info.msg(1) ? geometryOf(info.msg(1).msg(1)) : null;
                }
            }
            return null;
        }

        buildImage(o) {
            const pb = o.pb;
            const geo = geometryOf(pb.msg(1));
            const sources = [pb.ref(11), pb.ref(13), pb.ref(12)].filter(id => id !== null);
            const style = this.mediaStyle(pb.ref(3));
            let mask = null;
            const m = this.obj(pb.ref(5));
            if (m && m.type === T.MASK) {
                const mg = geometryOf(m.pb.msg(1));
                mask = transformPath(pathFromSource(m.pb.msg(2), mg.w, mg.h), frameMatrix(mg));
            }
            return { kind: 'image', geo, sources, mask, stroke: style.stroke, opacity: style.opacity, shadow: style.shadow };
        }

        buildMovie(o) {
            const pb = o.pb;
            const geo = geometryOf(pb.msg(1));
            const style = this.mediaStyle(pb.ref(19));
            return {
                kind: 'movie',
                geo,
                sources: [pb.ref(15)].filter(id => id !== null),
                movieId: pb.ref(14),
                name: (pb.msg(1) && pb.msg(1).str(8)) || 'Video',
                stroke: style.stroke,
                opacity: style.opacity,
                shadow: style.shadow
            };
        }

        buildGroup(o, ctx, depth) {
            const geo = geometryOf(o.pb.msg(1));
            const children = o.pb.refs(2).map(id => this.buildDrawable(id, ctx, depth + 1)).filter(Boolean);
            return children.length ? { kind: 'group', geo, children } : null;
        }

        buildUnsupported(o, label) {
            return { kind: 'unsupported', geo: geometryOf(o.pb.msg(1)), label };
        }

        slideFill(slideId) {
            const s = this.obj(slideId);
            if (!s) return null;
            const props = o => o.type === T.SLIDE_STYLE ? o.pb.msg(11) : null;
            return this.parseFill(this.lookup(s.pb.ref(1), props, p => p.has(1) ? p.msg(1) : undefined) || null);
        }

        drawOrder(pb) {
            const z = pb.refs(42);
            return z.length ? z : pb.refs(7);
        }

        slide(index) {
            if (this.slideCache.has(index)) return this.slideCache.get(index);
            const info = this.slides[index];
            const s = this.obj(info.slideId);
            const templateId = s.pb.ref(17);
            const template = this.obj(templateId);
            const ctx = { slideNumber: index + 1, template: templateId };
            const items = [];
            if (template) {
                for (const id of this.drawOrder(template.pb)) {
                    const t = this.obj(id);
                    if (!t || t.type === T.PLACEHOLDER) continue;
                    const it = this.buildDrawable(id, ctx, 0);
                    if (it) items.push(it);
                }
            }
            for (const id of this.drawOrder(s.pb)) {
                const it = this.buildDrawable(id, ctx, 0);
                if (it) items.push(it);
            }

            const background = this.slideFill(info.slideId) || (template ? this.slideFill(templateId) : null) ||
                { type: 'color', color: { r: 1, g: 1, b: 1, a: 1 } };

            // Collect media for the gallery and hit testing (absolute slide coordinates).
            const media = [];
            const walk = (list, m) => {
                for (const it of list) {
                    const fm = matMul(m, frameMatrix(it.geo));
                    if (it.kind === 'group') { walk(it.children, fm); continue; }
                    if (it.kind !== 'image' && it.kind !== 'movie') continue;
                    const pts = [[0, 0], [it.geo.w, 0], [it.geo.w, it.geo.h], [0, it.geo.h]]
                        .map(([x, y]) => [fm[0] * x + fm[2] * y + fm[4], fm[1] * x + fm[3] * y + fm[5]]);
                    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
                    media.push({
                        kind: it.kind, item: it,
                        x: Math.min(...xs), y: Math.min(...ys),
                        w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys)
                    });
                }
            };
            walk(items, [1, 0, 0, 1, 0, 0]);

            const titleId = s.pb.ref(5);
            const titleObj = this.obj(titleId);
            let title = '';
            if (titleObj && this.drawOrder(s.pb).includes(titleId)) {
                const info2 = titleObj.pb.msg(1);
                const storage = info2 && this.obj(info2.ref(4) !== null ? info2.ref(4) : info2.ref(2));
                if (storage) title = storage.pb.strs(3).join('').replace(/[\n\u2028\u2029\uFFFC]+/g, ' ').trim();
            }

            const result = { background, items, media, title };
            this.slideCache.set(index, result);
            return result;
        }

        slideTitle(index) {
            try { return this.slide(index).title; } catch (e) { return ''; }
        }

        // Starts loading a slide's pictures so it can be shown without delay later.
        preload(index) {
            if (index < 0 || index >= this.slides.length) return;
            const slide = this.slide(index);
            const load = fill => { if (fill && fill.type === 'image') this.image([fill.dataId]); };
            const walk = items => {
                for (const it of items) {
                    if (it.kind === 'group') walk(it.children);
                    else if ((it.kind === 'image' || it.kind === 'movie') && it.sources.length) this.image(it.sources);
                    else load(it.fill);
                }
            };
            load(slide.background);
            walk(slide.items);
        }

        // Media list for the sidebar gallery.
        async slideMedia(index) {
            const out = [];
            const seen = new Set();
            for (const m of this.slide(index).media) {
                const it = m.item;
                if (it.kind === 'image') {
                    const id = it.sources[0];
                    if (id === undefined || seen.has(id)) continue;
                    seen.add(id);
                    const thumb = it.sources[it.sources.length - 1];
                    // Prefer a format every browser can show (originals may be TIFF, HEIC or PDF).
                    const viewable = it.sources.find(s => /\.(jpe?g|png|gif|webp|bmp)$/i.test(this.mediaName(s)));
                    out.push({
                        kind: 'image',
                        url: await this.mediaURL(viewable !== undefined ? viewable : thumb),
                        thumb: await this.mediaURL(thumb),
                        name: this.mediaName(id)
                    });
                } else if (it.movieId !== null && !seen.has(it.movieId)) {
                    seen.add(it.movieId);
                    out.push({
                        kind: 'movie',
                        url: await this.mediaURL(it.movieId),
                        thumb: it.sources.length ? await this.mediaURL(it.sources[0]) : null,
                        name: it.name
                    });
                }
            }
            return out;
        }

        // Returns the movie under the given slide coordinate, if any.
        async movieAt(index, x, y) {
            const media = this.slide(index).media;
            for (let i = media.length - 1; i >= 0; i--) {
                const m = media[i];
                if (m.kind === 'movie' && x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h) {
                    return { url: await this.mediaURL(m.item.movieId), name: m.item.name };
                }
            }
            return null;
        }

        isOverMovie(index, x, y) {
            return this.slide(index).media.some(m => m.kind === 'movie' && x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h);
        }

        // ---------------- Rendering ----------------
        // Draws slide `index` with its top-left at (x, y), `scale` canvas pixels per point.
        render(ctx, index, x, y, scale) {
            const slide = this.slide(index);
            this.deviceScale = scale;
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(scale, scale);
            ctx.beginPath();
            ctx.rect(0, 0, this.width, this.height);
            ctx.clip();
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            this.fillPath(ctx, toPath2D(rectPath(this.width, this.height)), slide.background, this.width, this.height);
            for (const it of slide.items) this.drawItem(ctx, it);
            ctx.restore();
        }

        drawItem(ctx, it) {
            const g = it.geo;
            ctx.save();
            const m = frameMatrix(g);
            ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
            switch (it.kind) {
                case 'group':
                    for (const c of it.children) this.drawItem(ctx, c);
                    break;
                case 'shape':
                    this.drawShape(ctx, it);
                    break;
                case 'image':
                case 'movie':
                    this.drawImage(ctx, it);
                    break;
                case 'unsupported':
                    ctx.fillStyle = 'rgba(127,127,127,0.12)';
                    ctx.fillRect(0, 0, g.w, g.h);
                    ctx.strokeStyle = 'rgba(127,127,127,0.6)';
                    ctx.setLineDash([6, 4]);
                    ctx.strokeRect(0, 0, g.w, g.h);
                    ctx.fillStyle = 'rgba(80,80,80,0.9)';
                    ctx.font = '14px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText(it.label + ' (görüntülenemiyor)', g.w / 2, g.h / 2);
                    break;
            }
            ctx.restore();
        }

        applyShadow(ctx, shadow) {
            if (!shadow) return;
            const s = this.deviceScale || 1;
            const rad = shadow.angle * Math.PI / 180;
            ctx.shadowColor = cssColor(shadow.color, shadow.opacity);
            ctx.shadowBlur = shadow.radius * s;
            ctx.shadowOffsetX = Math.cos(rad) * shadow.offset * s;
            ctx.shadowOffsetY = -Math.sin(rad) * shadow.offset * s;
        }

        clearShadow(ctx) {
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
        }

        fillPath(ctx, path, fill, w, h) {
            if (!fill) return false;
            if (fill.type === 'color') {
                ctx.fillStyle = cssColor(fill.color);
                ctx.fill(path);
                return true;
            }
            if (fill.type === 'gradient') {
                let grad;
                if (fill.radial) {
                    const r = Math.hypot(w, h) / 2;
                    grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, r || 1);
                } else if (fill.transform) {
                    const t = fill.transform;
                    const sx = t.size && t.size[0] ? w / t.size[0] : 1, sy = t.size && t.size[1] ? h / t.size[1] : 1;
                    grad = ctx.createLinearGradient(t.start[0] * sx, t.start[1] * sy, t.end[0] * sx, t.end[1] * sy);
                } else {
                    const dx = Math.cos(fill.angle), dy = -Math.sin(fill.angle);
                    const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
                    grad = ctx.createLinearGradient(w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half);
                }
                for (const s of fill.stops) grad.addColorStop(s.t, cssColor(s.color, fill.opacity));
                ctx.fillStyle = grad;
                ctx.fill(path);
                return true;
            }
            if (fill.type === 'image') {
                const img = this.image([fill.dataId]);
                if (!img) return false;
                ctx.save();
                ctx.clip(path);
                const iw = img.naturalWidth, ih = img.naturalHeight;
                if (fill.technique === 2) {
                    const pattern = ctx.createPattern(img, 'repeat');
                    if (pattern) { ctx.fillStyle = pattern; ctx.fillRect(0, 0, w, h); }
                } else if (fill.technique === 1) {
                    ctx.drawImage(img, 0, 0, w, h);
                } else if (fill.technique === 0) {
                    ctx.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
                } else {
                    const s = fill.technique === 4 ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
                    ctx.drawImage(img, (w - iw * s) / 2, (h - ih * s) / 2, iw * s, ih * s);
                }
                ctx.restore();
                return true;
            }
            return false;
        }

        strokePath(ctx, path, stroke) {
            if (!stroke) return;
            ctx.strokeStyle = cssColor(stroke.color);
            ctx.lineWidth = stroke.width;
            ctx.lineCap = stroke.cap;
            ctx.lineJoin = stroke.join;
            ctx.setLineDash(stroke.dash || []);
            ctx.stroke(path);
            ctx.setLineDash([]);
        }

        drawShape(ctx, it) {
            const path = toPath2D(it.path);
            if (it.opacity < 1) ctx.globalAlpha *= it.opacity;
            if (it.fill || it.stroke) {
                this.applyShadow(ctx, it.shadow);
                const filled = this.fillPath(ctx, path, it.fill, it.geo.w, it.geo.h);
                if (filled) this.clearShadow(ctx);
                this.strokePath(ctx, path, it.stroke);
                this.clearShadow(ctx);
            }
            if (it.text) this.drawText(ctx, it.text, it.geo.w, it.geo.h);
        }

        drawImage(ctx, it) {
            const w = it.geo.w, h = it.geo.h;
            if (it.opacity < 1) ctx.globalAlpha *= it.opacity;
            const outline = toPath2D(it.mask || rectPath(w, h));
            const img = it.sources.length ? this.image(it.sources) : null;

            this.applyShadow(ctx, it.shadow);
            if (it.shadow) {
                // Cast the shadow from the visible outline, then draw the picture on top.
                ctx.fillStyle = 'rgba(255,255,255,1)';
                ctx.fill(outline);
                this.clearShadow(ctx);
            }
            ctx.save();
            ctx.clip(outline);
            if (img) {
                ctx.drawImage(img, 0, 0, w, h);
            } else {
                ctx.fillStyle = it.kind === 'movie' ? '#1b1b1b' : 'rgba(127,127,127,0.15)';
                ctx.fillRect(0, 0, w, h);
            }
            ctx.restore();
            this.strokePath(ctx, outline, it.stroke);

            if (it.kind === 'movie') {
                const r = Math.max(10, Math.min(36, Math.min(w, h) * 0.12));
                ctx.fillStyle = 'rgba(0,0,0,0.55)';
                ctx.beginPath();
                ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#fff';
                ctx.beginPath();
                ctx.moveTo(w / 2 - r * 0.35, h / 2 - r * 0.5);
                ctx.lineTo(w / 2 + r * 0.55, h / 2);
                ctx.lineTo(w / 2 - r * 0.35, h / 2 + r * 0.5);
                ctx.closePath();
                ctx.fill();
            }
        }

        // ---------------- Text layout ----------------
        // `k` scales font sizes and spacing (shrink text to fit).
        layoutText(ctx, block, innerW, k) {
            const TS = 4; // measure at 4x size so small fonts are not snapped to whole pixels
            const lines = [];
            let y = 0;
            let prevAfter = 0;

            block.paragraphs.forEach((para, pi) => {
                const label = para.label;
                const firstSize = (para.runs[0] || para.base).size * k;
                const base = para.leftIndent + (label ? label.indent : 0);
                let firstX = base + para.firstIndent;
                let restX = base;
                let labelBox = null;

                if (label && (label.text || label.imageId !== undefined && label.imageId !== null)) {
                    const lsize = label.size * k;
                    let lw;
                    if (label.text) {
                        ctx.font = fontCss(label.font, lsize * TS);
                        lw = ctx.measureText(label.text).width / TS;
                    } else {
                        lw = lsize * 0.8;
                    }
                    const textIndent = label.textIndentEm * firstSize;
                    labelBox = { x: firstX, w: lw, size: lsize };
                    restX = firstX + textIndent;
                    firstX = Math.max(firstX + textIndent, firstX + lw);
                }

                if (pi > 0) y += prevAfter + para.spaceBefore * k;
                prevAfter = para.spaceAfter * k;

                // Tokenize runs into words, spaces and forced breaks.
                const tokens = [];
                for (const run of para.runs) {
                    const size = run.size * k;
                    const css = fontCss(run.font, size * TS);
                    ctx.font = css;
                    const re = /\u2028|[ \t]+|[^ \t\u2028]+/g;
                    let m;
                    while ((m = re.exec(run.text))) {
                        const text = m[0];
                        if (text === '\u2028') { tokens.push({ brk: true, run, size }); continue; }
                        const space = text[0] === ' ' || text[0] === '\t';
                        const t = text.replace(/\t/g, '    ');
                        tokens.push({ text: t, space, run, size, css, w: ctx.measureText(t).width / TS });
                    }
                }

                const paraLines = [];
                let cur = { items: [], first: true };
                const availFor = line => innerW - (line.first ? firstX : restX) - para.rightIndent;
                const width = items => items.reduce((s, t) => s + t.w, 0);
                const trimEnd = items => { while (items.length && items[items.length - 1].space) items.pop(); return items; };
                const pushLine = forced => {
                    paraLines.push({ items: trimEnd(cur.items), first: cur.first, forced });
                    cur = { items: [], first: false };
                };

                for (const tok of tokens) {
                    if (tok.brk) { pushLine(true); continue; }
                    if (tok.space) {
                        if (cur.items.length || cur.first) cur.items.push(tok);
                        continue;
                    }
                    const avail = availFor(cur);
                    if (cur.items.some(t => !t.space) && width(cur.items) + tok.w > avail) pushLine(false);
                    if (tok.w > availFor(cur) && tok.text.length > 1) {
                        // Break words that are wider than the line.
                        ctx.font = tok.css;
                        let rest = tok.text;
                        while (rest) {
                            const room = availFor(cur) - width(cur.items);
                            let n = rest.length;
                            while (n > 1 && ctx.measureText(rest.slice(0, n)).width / TS > room) n--;
                            const part = rest.slice(0, n);
                            cur.items.push(Object.assign({}, tok, { text: part, w: ctx.measureText(part).width / TS }));
                            rest = rest.slice(n);
                            if (rest) pushLine(false);
                        }
                        continue;
                    }
                    cur.items.push(tok);
                }
                pushLine(true);

                paraLines.forEach((line, li) => {
                    const sizes = line.items.length ? line.items : [{ run: para.runs[0] || para.base, size: firstSize }];
                    let ascent = 0, descent = 0, natural = 0, maxSize = 0;
                    for (const t of sizes) {
                        const fm = fontMetrics(ctx, t.run.font);
                        ascent = Math.max(ascent, fm.ascent * t.size);
                        descent = Math.max(descent, fm.descent * t.size);
                        natural = Math.max(natural, fm.line * t.size);
                        maxSize = Math.max(maxSize, t.size);
                    }
                    if (li === 0 && labelBox) {
                        ascent = Math.max(ascent, labelBox.size * 0.8);
                        natural = Math.max(natural, labelBox.size * 1.1);
                    }
                    const sp = para.spacing;
                    let lh;
                    if (sp.mode === 1) lh = Math.max(natural, sp.amount * k);
                    else if (sp.mode === 2) lh = sp.amount * k;
                    else if (sp.mode >= 3) lh = natural + sp.amount * k;
                    else lh = natural * (sp.amount || 1);
                    // The first line of the text box gets no extra leading above it.
                    if (!lines.length && !sp.mode) lh = natural * Math.min(sp.amount || 1, 1);

                    const x0 = line.first ? firstX : restX;
                    const avail = innerW - x0 - para.rightIndent;
                    const contentW = width(line.items);
                    let offset = 0, extraPerSpace = 0, letterSpacing = 0;
                    const align = para.align;
                    if (align === 1) offset = avail - contentW;
                    else if (align === 2) offset = (avail - contentW) / 2;
                    else if (align === 3 && !line.forced && li < paraLines.length - 1 && avail > contentW) {
                        // Justify: widen word gaps, and once they get too wide spread the rest
                        // between letters as well (CoreText does the same).
                        const spaces = line.items.filter((t, i) => t.space && i > 0).length;
                        const chars = line.items.reduce((n, t) => n + (t.space ? 0 : [...t.text].length), 0);
                        const extra = avail - contentW;
                        const cap = maxSize * 0.25;
                        if (spaces && extra / spaces <= cap) {
                            extraPerSpace = extra / spaces;
                        } else if (chars > 1) {
                            extraPerSpace = spaces ? cap : 0;
                            letterSpacing = (extra - extraPerSpace * spaces) / (chars - 1);
                        }
                    }

                    const baseline = y + Math.max(ascent, lh - (natural - ascent));
                    let x = x0 + offset;
                    const placed = [];
                    line.items.forEach((t, i) => {
                        const ls = t.space ? 0 : letterSpacing;
                        const w = t.w + ls * [...(t.text || '')].length;
                        placed.push({ t, x, w, ls });
                        x += w + (t.space && i > 0 ? extraPerSpace : 0);
                    });

                    let lbl = null;
                    if (li === 0 && labelBox) {
                        const lx = (align === 1 || align === 2) ? x0 + offset - labelBox.w : labelBox.x;
                        lbl = { x: lx, size: labelBox.size, w: labelBox.w };
                    }
                    lines.push({ baseline, items: placed, label: lbl ? Object.assign(lbl, { def: label }) : null });
                    y += lh;
                });
            });
            return { lines, height: y };
        }

        drawText(ctx, block, w, h) {
            let ins = block.insets;
            // Text on a line (or any box thinner than its insets) is centred on the shape itself.
            if (h <= ins.t + ins.b) ins = { l: ins.l, r: ins.r, t: 0, b: 0 };
            const innerW = Math.max(1, w - ins.l - ins.r);
            const innerH = Math.max(0, h - ins.t - ins.b);
            let layout = this.layoutText(ctx, block, innerW, 1);
            if (block.shrink && innerH > 1 && layout.height > innerH * 1.01) {
                let lo = 0.2, hi = 1;
                for (let i = 0; i < 7; i++) {
                    const mid = (lo + hi) / 2;
                    if (this.layoutText(ctx, block, innerW, mid).height > innerH) hi = mid; else lo = mid;
                }
                layout = this.layoutText(ctx, block, innerW, lo);
            }

            let top = ins.t;
            if (block.valign === 1) top += (innerH - layout.height) / 2;
            else if (block.valign === 2) top += innerH - layout.height;

            const TS = 4;
            ctx.save();
            ctx.scale(1 / TS, 1 / TS);
            ctx.textBaseline = 'alphabetic';
            ctx.textAlign = 'left';
            for (const line of layout.lines) {
                const by = (top + line.baseline) * TS;
                if (line.label) {
                    const l = line.label, def = l.def;
                    const lx = (ins.l + l.x) * TS;
                    if (def.text) {
                        ctx.font = fontCss(def.font, l.size * TS);
                        ctx.fillStyle = cssColor(def.color);
                        ctx.fillText(def.text, lx, by);
                    } else if (def.imageId !== null && def.imageId !== undefined) {
                        const img = this.image([def.imageId]);
                        if (img) ctx.drawImage(img, lx, by - l.size * 0.75 * TS, l.w * TS, l.w * TS);
                    }
                }
                for (const p of line.items) {
                    const t = p.t;
                    const x = (ins.l + p.x) * TS;
                    ctx.fillStyle = cssColor(t.run.color);
                    if (!t.space) {
                        ctx.font = t.css;
                        if (p.ls) {
                            let cx = x;
                            for (const ch of t.text) {
                                ctx.fillText(ch, cx, by);
                                cx += ctx.measureText(ch).width + p.ls * TS;
                            }
                        } else {
                            ctx.fillText(t.text, x, by);
                        }
                    }
                    if (t.run.underline) {
                        ctx.fillRect(x, by + t.size * 0.12 * TS, p.w * TS, Math.max(1, t.size * 0.06 * TS));
                    }
                }
            }
            ctx.restore();
        }
    }

    async function looksLikeKeynote(file) {
        try {
            const zip = await ZipArchive.open(file);
            return zip.names().some(n => /(^|\/)Index\/Document\.iwa$|(^|\/)Index\.zip$/.test(n));
        } catch (e) {
            return false;
        }
    }

    global.KeynoteReader = {
        open: file => KeynoteDocument.open(file),
        looksLikeKeynote
    };
})(window);
