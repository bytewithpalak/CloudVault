// Rules for file names, folder paths, previews and download headers.

const BAD_CHARS = /[\x00-\x1f\x7f/\\]/;

function cleanName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name === '.' || name === '..' || name.length > 200 || BAD_CHARS.test(name)) return null;
    return name;
}

// "/", "/notes" or "/notes/cloud". Returns null when invalid.
function cleanFolder(value) {
    if (value === undefined || value === null || value === '') return '/';
    if (typeof value !== 'string') return null;

    const parts = value.split('/').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 8 || parts.some((p) => !cleanName(p) || p.length > 60)) return null;

    return '/' + parts.join('/');
}

const TYPES = {
    image: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' },
    pdf: { pdf: 'application/pdf' },
    video: { mp4: 'video/mp4', webm: 'video/webm' },
    audio: { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' }
};

// shown as plain text, so uploaded HTML or SVG can never run as a page
const TEXT = 'txt md csv json js ts py java c h cpp css html xml svg sql log yml yaml sh'.split(' ');

// How a browser can show this file, or null if it cannot.
function previewType(name) {
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';

    for (const [kind, extensions] of Object.entries(TYPES)) {
        if (Object.hasOwn(extensions, ext)) return { kind, mime: extensions[ext] };
    }

    return TEXT.includes(ext) ? { kind: 'text', mime: 'text/plain; charset=utf-8' } : null;
}

// Content-Disposition that survives quotes and non-English file names.
function disposition(type, name) {
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    // the UTF-8 round trip replaces broken characters, which encodeURIComponent rejects
    const encoded = encodeURIComponent(Buffer.from(name, 'utf8').toString('utf8')).replace(
        /['()*]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
    );

    return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

module.exports = { cleanName, cleanFolder, previewType, disposition };
