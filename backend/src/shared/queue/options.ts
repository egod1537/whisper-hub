import path from 'node:path';
import { AppError } from '../errors.js';
import { outputFormats, type OutputFormat } from './types.js';

const supportedLanguages = new Set([
  'auto', 'af', 'am', 'ar', 'as', 'az', 'ba', 'be', 'bg', 'bn', 'bo', 'br', 'bs', 'ca', 'cs', 'cy', 'da',
  'de', 'el', 'en', 'es', 'et', 'eu', 'fa', 'fi', 'fo', 'fr', 'gl', 'gu', 'ha', 'haw', 'he', 'hi', 'hr',
  'ht', 'hu', 'hy', 'id', 'is', 'it', 'ja', 'jw', 'ka', 'kk', 'km', 'kn', 'ko', 'la', 'lb', 'ln', 'lo',
  'lt', 'lv', 'mg', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my', 'ne', 'nl', 'nn', 'no', 'oc', 'pa',
  'pl', 'ps', 'pt', 'ro', 'ru', 'sa', 'sd', 'si', 'sk', 'sl', 'sn', 'so', 'sq', 'sr', 'su', 'sv', 'sw',
  'ta', 'te', 'tg', 'th', 'tk', 'tl', 'tr', 'tt', 'uk', 'ur', 'uz', 'vi', 'yi', 'yo', 'zh',
]);
const canonicalFormats = new Map(outputFormats.map((format, index) => [format, index]));

export function parseFormats(value: string | readonly string[] | undefined): OutputFormat[] {
  const parts = value === undefined || value === ''
    ? ['txt', 'srt', 'json']
    : typeof value === 'string' ? value.split(',').map((item) => item.trim()) : [...value];
  if (parts.length === 0 || parts.some((item) => !canonicalFormats.has(item as OutputFormat)) || new Set(parts).size !== parts.length) {
    throw new AppError('VALIDATION_FAILED', 'Formats must be a unique subset of txt,srt,vtt,json.', 422);
  }
  return (parts as OutputFormat[]).sort((a, b) => (canonicalFormats.get(a) ?? 0) - (canonicalFormats.get(b) ?? 0));
}

export function parseLanguage(value: string | undefined): string {
  const language = (value ?? 'auto').toLowerCase();
  if (!supportedLanguages.has(language)) throw new AppError('LANGUAGE_UNSUPPORTED', 'Language is not supported.', 422);
  return language;
}

export function normalizeFilename(value: string): string {
  const filename = path.basename(value.replaceAll('\\', '/')).replace(/[\p{Cc}]/gu, '_').slice(0, 255);
  return filename || 'upload';
}
