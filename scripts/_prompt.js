'use strict';
// Pergunta a senha no terminal (ou usa a variável de ambiente indicada, para automação).
const readline = require('node:readline');
const { passwordPolicyError } = require('../src/security');

function askPassword(envVar) {
  return new Promise((resolve) => {
    const done = (pw) => {
      const err = passwordPolicyError(pw);
      if (err) { console.error(err); process.exit(1); }
      resolve(pw);
    };
    if (envVar && process.env[envVar]) return done(process.env[envVar]);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Senha (mín. 10 caracteres, letras e números): ', (pw) => { rl.close(); done(pw); });
  });
}
const validEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

module.exports = { askPassword, validEmail };
