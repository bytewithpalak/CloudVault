const dns = require('dns').promises;

const PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const TYPOS = {
    'gmial.com': 'gmail.com',
    'gmai.com': 'gmail.com',
    'gamil.com': 'gmail.com',
    'gnail.com': 'gmail.com',
    'gmail.co': 'gmail.com',
    'gmail.con': 'gmail.com',
    'yaho.com': 'yahoo.com',
    'yahooo.com': 'yahoo.com',
    'hotmial.com': 'hotmail.com',
    'outlok.com': 'outlook.com'
};

// Can the domain receive mail? Only a definite "no" rejects the address,
// so a slow or broken DNS server never blocks a real user.
async function domainAcceptsMail(domain) {
    const resolver = new dns.Resolver({ timeout: 3000, tries: 2 });

    try {
        const records = await resolver.resolveMx(domain);
        return records.some((r) => r.exchange && r.exchange !== '.');
    } catch (err) {
        return !['ENOTFOUND', 'ENODATA'].includes(err.code);
    }
}

async function checkEmail(value) {
    const email = typeof value === 'string' ? value.trim().toLowerCase() : '';

    if (email.length > 254 || email.indexOf('@') > 64 || !PATTERN.test(email)) {
        return { error: 'Enter a valid email address' };
    }

    const domain = email.split('@')[1];

    if (TYPOS[domain]) {
        return { error: `Did you mean ${email.split('@')[0]}@${TYPOS[domain]}?` };
    }
    if (!(await domainAcceptsMail(domain))) {
        return { error: `The domain "${domain}" cannot receive email` };
    }

    return { email };
}

module.exports = { checkEmail };
