import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();

// serve public folder
app.use(express.static(path.join(__dirname, 'public')));

// serve the BPMN file
app.get('/diagram.bpmn', (req, res) =>
  res.sendFile(path.join(__dirname, 'diagram.bpmn'))
);

// serve the bpmn-js dist bundle
app.use(
  '/scripts',
  express.static(path.join(__dirname, 'node_modules', 'bpmn-js', 'dist'))
);

app.listen(3000, () =>
  console.log('→ Open http://localhost:3000/')
);
