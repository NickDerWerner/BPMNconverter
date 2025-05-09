/* converter.js — JSON ➜ BPMN 2.0 XML + DI (sequence + message flows, multi‑pool)
   prerequisites:
     npm i bpmn-moddle bpmn-auto-layout
   ensure package.json contains: "type": "module"

   Tweakable layout constants ↓↓↓
*/

const LEFT_POOL_PADDING = 30;  // extra gap between left pool border and first node (px)
const POOL_SPACING      = 60;  // vertical gap between pools (px)

import { layoutProcess } from 'bpmn-auto-layout';
import BpmnModdle        from 'bpmn-moddle';
import fs                from 'node:fs/promises';

/* 1 ─── load structured JSON ──────────────────────────────────── */
const processJson = JSON.parse(
  await fs.readFile(new URL('./test.json', import.meta.url))
);

/* 2 ─── helpers ───────────────────────────────────────────────── */
const capitalize = s => s[0].toUpperCase() + s.slice(1);

function wire(flow, source, target) {
  (source.outgoing = source.outgoing || []).push(flow);
  (target.incoming = target.incoming || []).push(flow);
}

/* geometric helpers */
const copyBounds = (src, xOffset = 0, yOffset = 0) => ({
  x: src.x + xOffset,
  y: src.y + yOffset,
  width: src.width,
  height: src.height
});

const copyWaypoints = (wps, xOffset = 0, yOffset = 0) =>
  wps.map(wp => ({ x: wp.x + xOffset, y: wp.y + yOffset }));

/* compute a docking point on the border of a shape in the direction of target */
function dockPoint(shape, targetShape) {
  const { x, y, width, height } = shape.bounds;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const tx = targetShape.bounds.x + targetShape.bounds.width / 2;
  const ty = targetShape.bounds.y + targetShape.bounds.height / 2;

  const dx = tx - cx;
  const dy = ty - cy;

  if (Math.abs(dx) > Math.abs(dy)) {
    return { x: dx > 0 ? x + width : x, y: cy }; // left/right edge
  }
  return { x: cx, y: dy > 0 ? y + height : y };  // top/bottom edge
}

/* 3 ─── moddle root defs + collaboration shell ───────────────── */
const moddle = new BpmnModdle();

const definitions = moddle.create('bpmn:Definitions', {
  id:              'Defs_1',
  targetNamespace: 'http://example.com/bpmn',
  rootElements:    []
});

const collaboration = moddle.create('bpmn:Collaboration', {
  id:           'Collab_1',
  participants: [],
  messageFlows: []
});

definitions.get('rootElements').push(collaboration);

/* 4 ─── normalise pools (legacy JSON => single pool) ──────────── */
const pools = Array.isArray(processJson.pools)
  ? processJson.pools
  : [{
      id:    processJson.id   ?? 'Pool_1',
      name:  processJson.name ?? 'Pool 1',
      nodes: processJson.nodes ?? [],
      flows: processJson.flows ?? []
    }];

const byId            = {};  // ANY BPM element id → element
const poolOfNode      = {};  // node id → pool id
const messageFlowSpecs = Array.isArray(processJson.crossFlows) ? [...processJson.crossFlows] : [];

/* 5 ─── create one <Process> per pool + its nodes ─────────────── */
const processByPool = {};

for (const pool of pools) {
  const processEl = moddle.create('bpmn:Process', {
    id:           `Proc_${pool.id}`,
    name:         pool.name,
    isExecutable: true,
    flowElements: []
  });
  definitions.get('rootElements').push(processEl);
  processByPool[pool.id] = processEl;

  for (const n of pool.nodes) {
    /* basic BPMN element for the node */
    const el = moddle.create(`bpmn:${capitalize(n.type)}`, {
      id:   n.id,
      name: n.name
    });

    /* attach an event definition if the JSON specifies one */
    if (n.eventDefinitionType) {
      // ① create the empty event definition (Message-, Timer-, …)
      const evDef = moddle.create(n.eventDefinitionType, {});

      // ② for message events keep a concrete <bpmn:message> (optional)
      if (n.eventDefinitionType === 'bpmn:MessageEventDefinition' && n.message) {
        const msg = moddle.create('bpmn:Message', {
          id:   `${capitalize(n.message)}_msg`,
          name: n.message
        });
        definitions.get('rootElements').push(msg);
        evDef.messageRef = msg;          // reference the object, not the id
      }

      // ③ wire the definition to the event element
      el.eventDefinitions = [ evDef ];
    }

    processEl.flowElements.push(el);
    byId[n.id]       = el;
    poolOfNode[n.id] = pool.id;
  }
}

/* 6 ─── intra‑ vs cross‑pool flows (store cross for later) ───── */
for (const pool of pools) {
  for (const f of pool.flows) {
    const crossPool = poolOfNode[f.source] !== poolOfNode[f.target];
    if (crossPool || f.type === 'messageFlow') {
      messageFlowSpecs.push(f);
      continue;
    }

    const seq = moddle.create('bpmn:SequenceFlow', {
      id:        f.id,
      name:      f.condition || '',
      sourceRef: byId[f.source],
      targetRef: byId[f.target],
      ...(f.condition && {
        conditionExpression: moddle.create('bpmn:FormalExpression', { body: f.condition })
      })
    });
    processByPool[pool.id].flowElements.push(seq);
    wire(seq, byId[f.source], byId[f.target]);
    byId[seq.id] = seq;
  }
}

/* 7 ─── DI: auto‑layout each process individually ─────────────── */
const diagram = moddle.create('bpmndi:BPMNDiagram', { id: 'Diagram_1' });
const plane   = moddle.create('bpmndi:BPMNPlane',  { id: 'Plane_1', bpmnElement: collaboration, planeElement: [] });

diagram.set('plane', plane);
definitions.set('diagrams', [diagram]);

let yOffset = 0;

for (const pool of pools) {
  const proc = processByPool[pool.id];

  /* temp defs containing only THIS process */
  const tmpDefs = moddle.create('bpmn:Definitions', {
    id:              `Tmp_${pool.id}`,
    targetNamespace: 'http://example.com/bpmn',
    rootElements:    [proc]
  });

  const { xml: tmpXml } = await moddle.toXML(tmpDefs);
  const laidXml          = await layoutProcess(tmpXml);
  const { rootElement: laidDefs } = await moddle.fromXML(laidXml, { lax: true });
  const laidPlane = laidDefs.diagrams[0].plane;

  /* copy shapes and edges into main plane, offset vertically + LEFT padding */
  laidPlane.planeElement.forEach(el => {
    if (el.$type === 'bpmndi:BPMNShape') {
      plane.planeElement.push(
        moddle.create('bpmndi:BPMNShape', {
          id:          `${el.id}_g`,
          bpmnElement: byId[el.bpmnElement.id],
          bounds:      moddle.create('dc:Bounds', copyBounds(el.bounds, LEFT_POOL_PADDING, yOffset))
        })
      );
    } else if (el.$type === 'bpmndi:BPMNEdge') {
      plane.planeElement.push(
        moddle.create('bpmndi:BPMNEdge', {
          id:          `${el.id}_g`,
          bpmnElement: byId[el.bpmnElement.id],
          waypoint: copyWaypoints(el.waypoint, LEFT_POOL_PADDING, yOffset)
                      .map(pt => moddle.create('dc:Point', pt))
        })
      );
    }
  });

   /* participant (pool) */
   const participant = moddle.create('bpmn:Participant', {
    id:         `Part_${pool.id}`,
    name:       pool.name,
    processRef: proc
  });
  collaboration.participants.push(participant);

  /* bounding box for this pool – account for extra LEFT padding */
  const nodeShapes = plane.planeElement.filter(
    s => s.$type === 'bpmndi:BPMNShape' && pool.nodes.some(n => n.id === s.bpmnElement.id)
  );

  const minX = Math.min(...nodeShapes.map(s => s.bounds.x)) - (30 + LEFT_POOL_PADDING);
  const minY = Math.min(...nodeShapes.map(s => s.bounds.y)) - 30;
  const maxX = Math.max(...nodeShapes.map(s => s.bounds.x + s.bounds.width)) + 30;
  const maxY = Math.max(...nodeShapes.map(s => s.bounds.y + s.bounds.height)) + 30;

  plane.planeElement.unshift(
    moddle.create('bpmndi:BPMNShape', {
      id:          `Part_${pool.id}_di`,
      bpmnElement: participant,
      isHorizontal: true,
      bounds: moddle.create('dc:Bounds', {
        x:      minX,
        y:      minY,
        width:  maxX - minX,
        height: maxY - minY
      })
    })
  );

  yOffset = maxY + POOL_SPACING; // vertical offset for next pool
}

/* 8 ─── message flows + DI edges with proper docking ─────────── */
const shapeById = Object.fromEntries(
  plane.planeElement
    .filter(el => el.$type === 'bpmndi:BPMNShape')
    .map(s => [s.bpmnElement.id, s])
);

for (const mf of messageFlowSpecs) {
  const src = byId[mf.source];
  const tgt = byId[mf.target];
  if (!src || !tgt) {
    console.warn(`⚠️  Message flow ${mf.id} references unknown node(s). Skipped.`);
    continue;
  }

  const msgFlow = moddle.create('bpmn:MessageFlow', {
    id:        mf.id,
    name:      mf.name ?? mf.condition ?? '',
    sourceRef: src,
    targetRef: tgt
  });
  collaboration.messageFlows.push(msgFlow);
  wire(msgFlow, src, tgt);
  byId[msgFlow.id] = msgFlow;

  const srcShape = shapeById[src.id];
  const tgtShape = shapeById[tgt.id];
  if (srcShape && tgtShape) {
    const start = dockPoint(srcShape, tgtShape);
    const end   = dockPoint(tgtShape, srcShape);

    plane.planeElement.push(
      moddle.create('bpmndi:BPMNEdge', {
        id:          `${mf.id}_di`,
        bpmnElement: msgFlow,
        waypoint: [start, end].map(pt => moddle.create('dc:Point', pt))
      })
    );
  }
}

/* 9 ─── final serialisation + save ───────────────────────────── */
const { xml: finalXml } = await moddle.toXML(definitions, { format: true });
await fs.writeFile('diagram.bpmn', finalXml, 'utf8');
console.log('✅  Layouted diagram (multiple pools) saved to diagram.bpmn');

