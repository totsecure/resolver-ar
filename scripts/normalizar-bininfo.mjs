#!/usr/bin/env node
/* Normaliza y sanea bininfo: una sola convención, y elimina cache incompleto
 * de fuentes externas (banco vacío). El dataset manda. */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { marca, tipo, nivel, pais, pais2, moneda } from '../lib/normalizar-bin.js';

const RAIZ = '/Volumes/Boveda/resolver';
const stock = new DatabaseSync(path.join(RAIZ, 'datos', 'stock.db'));
stock.exec('PRAGMA busy_timeout=8000');
stock.exec('CREATE TABLE IF NOT EXISTS bininfo(bin TEXT PRIMARY KEY, marca TEXT, tipo TEXT, nivel TEXT, banco TEXT, pais TEXT, pais2 TEXT, moneda TEXT, json TEXT, fuente TEXT, actualizado TEXT)');
const malas = stock.prepare("DELETE FROM bininfo WHERE fuente <> 'dataset' AND (banco IS NULL OR banco='')").run();
const filas = stock.prepare('SELECT bin, marca, tipo, nivel, banco, pais, pais2, moneda FROM bininfo').all();
const up = stock.prepare('UPDATE bininfo SET marca=?, tipo=?, nivel=?, banco=?, pais=?, pais2=?, moneda=? WHERE bin=?');
stock.exec('BEGIN IMMEDIATE');
try {
  for (const f of filas) {
    up.run(marca(f.marca), tipo(f.tipo), nivel(f.nivel), f.banco, pais(f.pais), pais2(f.pais2), moneda(f.moneda), f.bin);
  }
  stock.exec('COMMIT');
} catch (e) { try { stock.exec('ROLLBACK'); } catch (_) {} throw e; }
stock.close();
console.log('bininfo normalizado:', filas.length, 'filas | eliminadas incompletas externas:', Number(malas.changes || 0));
