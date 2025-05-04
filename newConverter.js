/* converter.js — JSON ➜ BPMN 2.0 XML + DI (sequence + message flows)
   prerequisites:
     npm i bpmn-moddle bpmn-auto-layout
   ensure package.json contains: "type": "module"
*/

import { layoutProcess } from 'bpmn-auto-layout';
import BpmnModdle        from 'bpmn-moddle';
import fs                from 'node:fs/promises';

/* 1 ─── load structured JSON ──────────────────────────────────── */
const processJson = JSON.parse(
  await fs.readFile(new URL('./TUMprocess.json', import.meta.url))
);

/* 2 ─── helpers ───────────────────────────────────────────────── */
const capitalize = s => s[0].toUpperCase() + s.slice(1);

function wire(flow, source, target) {
  (source.outgoing = source.outgoing || []).push(flow);
  (target.incoming = target.incoming || []).push(flow);
}

/* 3 ─── build BPMN definitions WITHOUT message flows ─────────── */
const moddle = new BpmnModdle();

const processEl = moddle.create('bpmn:Process', {
  id:           processJson.id,
  name:         processJson.name,
  isExecutable: true,
  flowElements: []
});

/* remember nodes by id */
const byId = {};
for (const n of processJson.nodes) {
  const el = moddle.create(`bpmn:${capitalize(n.type)}`, {
    id:   n.id,
    name: n.name
  });
  processEl.flowElements.push(el);
  byId[n.id] = el;
}

/* collect message‑flows for later */
const messageFlowSpecs = [];

for (const f of processJson.flows) {
  if (f.type === 'messageFlow') {
    messageFlowSpecs.push(f);
    continue; // handled after layout
  }

  /* default to sequence flow */
  const flow = moddle.create('bpmn:SequenceFlow', {
    id:        f.id,
    name:      f.condition || '',
    sourceRef: byId[f.source],
    targetRef: byId[f.target],
    ...(f.condition && {
      conditionExpression: moddle.create('bpmn:FormalExpression', {
        body: f.condition
      })
    })
  });
  processEl.flowElements.push(flow);
  wire(flow, byId[f.source], byId[f.target]);
}

/* wrap process in <bpmn:Definitions> */
const definitions = moddle.create('bpmn:Definitions', {
  id:              'Defs_1',
  targetNamespace: 'http://example.com/bpmn',
  rootElements:    [processEl]
});

/* 4 ─── serialise and auto‑layout SEQUENCE flows only ─────────── */
const { xml } = await moddle.toXML(definitions, { format: true });
const seqLayoutXml = await layoutProcess(xml);

/* 5 ─── re‑parse the DI‑enriched XML ──────────────────────────── */
const { rootElement: defs } = await moddle.fromXML(seqLayoutXml, {
  lax: true
});

/* convenience maps */
const proc        = defs.rootElements.find(e => e.$type === 'bpmn:Process');
const nodeById    = Object.fromEntries(proc.flowElements.map(e => [e.id, e]));
const diagram     = defs.diagrams[0];
const plane       = diagram.plane;
const shapeById   = Object.fromEntries(
  plane.planeElement
    .filter(el => el.$type === 'bpmndi:BPMNShape')
    .map(s => [s.bpmnElement.id, s])
);

/* helper to compute a shape’s centre */
const centre = shape => {
  const { x, y, width, height } = shape.bounds;
  return { x: x + width / 2, y: y + height / 2 };
};

/* 6 ─── add <bpmn:Collaboration>, participants + message flows ─ */
const collaboration = moddle.create('bpmn:Collaboration', {
  id:           'Collab_1',
  participants: [],
  messageFlows: []
});

defs.rootElements.push(collaboration);

/* pool covering the (single) process */
collaboration.participants.push(
  moddle.create('bpmn:Participant', {
    id:         'Participant_1',
    processRef: proc,
    name:       processJson.name || 'Pool 1'
  })
);

/* create message flows + DI edges */
for (const mf of messageFlowSpecs) {
  const source = nodeById[mf.source];
  const target = nodeById[mf.target];

  if (!source || !target) {
    console.warn(`⚠️  Message flow ${mf.id} references unknown node(s). Skipped.`);
    continue;
  }

  const msgFlow = moddle.create('bpmn:MessageFlow', {
    id:        mf.id,
    name:      mf.name ?? mf.condition ?? '',
    sourceRef: source,
    targetRef: target
  });
  collaboration.messageFlows.push(msgFlow);
  wire(msgFlow, source, target);

  /* DI – simple straight line between centres */
  const srcShape = shapeById[source.id];
  const tgtShape = shapeById[target.id];

  if (srcShape && tgtShape) {
    const p1 = centre(srcShape);
    const p2 = centre(tgtShape);

    const edge = moddle.create('bpmndi:BPMNEdge', {
      id:            `${mf.id}_di`,
      bpmnElement:   msgFlow,
      waypoint: [
        moddle.create('dc:Point', p1),
        moddle.create('dc:Point', p2)
      ]
    });
    plane.planeElement.push(edge);
  }
}

/* 7 ─── final serialisation + save ────────────────────────────── */
const { xml: finalXml } = await moddle.toXML(defs, { format: true });
await fs.writeFile('diagram.bpmn', finalXml);
console.log('✅  Layouted diagram (incl. message flows) saved to diagram.bpmn');
