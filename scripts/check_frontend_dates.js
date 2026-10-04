import fs from 'fs';
const html = fs.readFileSync('./public/index.html', 'utf8');

const lines = html.split('\n');
const matched = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('fetchData') || lines[i].includes('loadDate') || lines[i].includes('currentWorkDate') || lines[i].includes('handleDateChange')) {
    matched.push(`${i+1}: ${lines[i].trim()}`);
  }
}
console.log(matched.slice(0, 30).join('\n'));
