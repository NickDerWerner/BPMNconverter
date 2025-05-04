/* converter.js — JSON ➜ BPMN 2.0 XML + DI
   prerequisites:
     npm i bpmn-moddle bpmn-auto-layout
   make sure package.json contains:  "type": "module"
*/

import { layoutProcess } from 'bpmn-auto-layout';
import BpmnModdle        from 'bpmn-moddle';
import fs                from 'node:fs/promises';

/* 1 ─── load your structured JSON ──────────────────────────────── */
const processJson = JSON.parse(
  await fs.readFile(new URL('./TUMprocess.json', import.meta.url))
);

/* 2 ─── helpers ────────────────────────────────────────────────── */
const capitalize = s => s[0].toUpperCase() + s.slice(1);

function wire(flow, source, target) {
  (source.outgoing = source.outgoing || []).push(flow);
  (target.incoming = target.incoming || []).push(flow);
}

/* 3 ─── build the BPMN object graph ────────────────────────────── */
const moddle = new BpmnModdle();

/* 3.1  <bpmn:Process> container */
const processEl = moddle.create('bpmn:Process', {
  id:           processJson.id,
  name:         processJson.name,
  isExecutable: true,
  flowElements: []
});

/* 3.2  all nodes */
const byId = {};
for (const n of processJson.nodes) {
  const el = moddle.create(`bpmn:${capitalize(n.type)}`, {
    id:   n.id,
    name: n.name
  });
  processEl.flowElements.push(el);
  byId[n.id] = el;
}

/* 3.3  flows */
for (const f of processJson.flows) {
  const flow = moddle.create(`bpmn:${capitalize(f.type)}`, {
    id:        f.id,
    sourceRef: byId[f.source],
    targetRef: byId[f.target],
    // label AND executable condition, if given
    ...(f.condition && {
      name: f.condition,
      conditionExpression: moddle.create('bpmn:FormalExpression', {
        body: f.condition
      })
    })
  });

  processEl.flowElements.push(flow);
  wire(flow, byId[f.source], byId[f.target]);   // **key for auto-layout**
}

/* 4 ─── wrap in <bpmn:Definitions> and serialise ──────────────── */
const definitions = moddle.create('bpmn:Definitions', {
  id:              'Defs_1',
  targetNamespace: 'http://example.com/bpmn',
  rootElements:    [processEl]
});

const { xml } = await moddle.toXML(definitions, { format: true });

/* 5 ─── add DI (waypoints) in one line ─────────────────────────── */
const layoutedXml = await layoutProcess(xml);

/* 6 ─── save to disk ───────────────────────────────────────────── */
await fs.writeFile('diagram.bpmn', layoutedXml);
console.log('✅  Layouted diagram saved to diagram.bpmn');
