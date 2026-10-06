import { loadStatsParams } from './stats-params.js';
import { formatStats, generateStats } from './stats.js';

const { seed, rows, now } = loadStatsParams(process.env);
console.log(formatStats(generateStats(seed, rows, now)));
