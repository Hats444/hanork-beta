'use strict';
/** Onda2.9: retorno de executarConsulta nao espalha data/output da ficha. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../commands/consultas.js'), 'utf8');
assert.ok(/Politica nao-retencao|Nao-retencao/.test(src), 'comentario nao-retencao');
assert.ok(!/return \{ \.\.\.result, output/.test(src), 'nao espalha result+output');
assert.ok(src.includes("['Valor', '***']"), 'progress sem query em claro');
assert.ok(src.includes('maskConsultaParam'), 'audit mascara param');

console.log('consulta-noretain-smoke ok');
