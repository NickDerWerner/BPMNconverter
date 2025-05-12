/* converter.js — JSON ➜ BPMN 2.0 XML + DI (sequence + message + data‑associations, multi‑pool)
   prerequisites:
     npm i bpmn-moddle bpmn-auto-layout
   ensure package.json contains: "type": "module"

   Tweakable layout constants ↓↓↓
*/
const DATA_OBJECT_H_GAP = 40;  // horizontal gap between task and data object (px)
const DATA_OBJECT_V_GAP = 40;  // vertical gap between task and data object (px)
const LEFT_POOL_PADDING = 30;  // extra gap between left pool border and first node (px)
const POOL_SPACING      = 60;  // vertical gap between pools (px)

import { layoutProcess } from 'bpmn-auto-layout';
import BpmnModdle        from 'bpmn-moddle';
import fs                from 'node:fs/promises';

/* 1 ─── load structured JSON ──────────────────────────────────── */
const processJson = JSON.parse(
  await fs.readFile(new URL('processTests/gemini1.json', import.meta.url))
);

/* 2 ─── helpers ───────────────────────────────────────────────── */
const capitalize = s => s[0].toUpperCase() + s.slice(1);

/* JSON → BPMN node‑name map for the few types that do not match a simple capitalise() */
const NODE_TYPE_MAP = {
  dataobject:          'DataObjectReference', // JSON uses dataobject, BPMN uses DataObjectReference
  dataobjectreference: 'DataObjectReference',
  datastore:           'DataStoreReference'
};

function wire(flow, source, target) {
  // Data associations are a bit different:
  // - DataInputAssociation: Source is DataObjectReference, Target is Activity
  // - DataOutputAssociation: Source is Activity, Target is DataObjectReference
  // The 'flow' element itself has sourceRef and targetRef.
  // The Activity has incoming/outgoing data associations.
  // The DataObjectReference has incoming/outgoing data associations (though less common in tools DI).
  // The 'wire' function as implemented adds the *association element* to incoming/outgoing lists.
  // This is slightly non-standard but tolerated by moddle and viewers.
  // Standard is: Activity.dataInputAssociations/dataOutputAssociations = [assoc], DataObjectReference.dataState = ...
  // Let's stick to the current wire function for simplicity with existing code structure,
  // as the main issue is the missing DI edge.
  (source.outgoing = source.outgoing || []).push(flow);
  (target.incoming = target.incoming || []).push(flow);

  // More BPMN-standard way (but requires knowing element types):
  // if (flow.$type === 'bpmn:DataInputAssociation') {
  //    (target.dataInputAssociations = target.dataInputAssociations || []).push(flow);
  // } else if (flow.$type === 'bpmn:DataOutputAssociation') {
  //    (source.dataOutputAssociations = source.dataOutputAssociations || []).push(flow);
  // }
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
  // Need actual shape bounds, not just the bpmnElement
  const sourceBounds = shape.bounds;
  const targetBounds = targetShape.bounds;

  const { x, y, width, height } = sourceBounds;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const tx = targetBounds.x + targetBounds.width / 2;
  const ty = targetBounds.y + targetBounds.height / 2;

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

const byId             = {}; // ANY BPM element id → element (bpmn: element)
const poolOfNode       = {}; // node id → pool id
const messageFlowSpecs = Array.isArray(processJson.crossFlows) ? [...processJson.crossFlows] : [];
const dataAssociationSpecs = []; // Array to store data association specs for later DI creation


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
    // Use DataObjectReference for type 'dataobject'
    const bpmnName = NODE_TYPE_MAP[n.type.toLowerCase()] ?? capitalize(n.type);
    const el = moddle.create(`bpmn:${bpmnName}`, {
      id:   n.id,
      name: n.name,
      ...(n.isCollection != null && { isCollection: n.isCollection })
      // Note: DataObjectReference usually points to a DataObject via dataObjectRef.
      // The current JSON doesn't define separate DataObject elements,
      // and some tools tolerate DataObjectReferences without a corresponding DataObject.
      // We will proceed without creating DataObject elements for simplicity, matching the JSON.
    });

    /* optional eventDefinitionType */
    if (n.eventDefinitionType) {
      const evDef = moddle.create(`bpmn:${capitalize(n.eventDefinitionType)}`, {});
      el.eventDefinitions = [ evDef ];
    }

    processEl.flowElements.push(el);
    byId[n.id]       = el; // Store the created bpmn: element
    poolOfNode[n.id] = pool.id;
  }
}
/* 6 ─── intra‑ vs cross‑pool flows (store cross/data for later) ───── */
for (const pool of pools) {
    const currentProcessEl = processByPool[pool.id]; // Get the process for this pool

    for (const f of pool.flows) {
      const src = byId[f.source];
      const tgt = byId[f.target];

      if (!src || !tgt) {
        console.warn(`⚠️ Flow ${f.id} references unknown node(s) ${f.source} -> ${f.target}. Skipped.`);
        continue;
      }

      const crossPool   = poolOfNode[f.source] !== poolOfNode[f.target];
      const isMsgFlow   = f.type === 'messageFlow';
      const isDataAssoc = /data(Input|Output)?Association/i.test(f.type);

      if (crossPool || isMsgFlow) {
        messageFlowSpecs.push(f);
        continue;
      }

      if (isDataAssoc) {
        /* DataInputAssociation / DataOutputAssociation */
        let activityElement, dataObjectReferenceElement;

        // Determine which element is the Activity and which is the Data Object/Store Reference
        const srcIsActivity = src.$type.includes('Activity') || src.$type.includes('Task') || src.$type.includes('SubProcess') || src.$type.includes('CallActivity');
        const tgtIsActivity = tgt.$type.includes('Activity') || tgt.$type.includes('Task') || tgt.$type.includes('SubProcess') || tgt.$type.includes('CallActivity');
        const srcIsDataObject = src.$type === 'bpmn:DataObjectReference' || src.$type === 'bpmn:DataStoreReference';
        const tgtIsDataObject = tgt.$type === 'bpmn:DataObjectReference' || tgt.$type === 'bpmn:DataStoreReference';


        if (srcIsActivity && tgtIsDataObject) {
            activityElement = src;
            dataObjectReferenceElement = tgt;
        } else if (srcIsDataObject && tgtIsActivity) {
            activityElement = tgt;
            dataObjectReferenceElement = src;
        } else {
            console.warn(`⚠️ Data association ${f.id}: Does not connect an Activity and a Data Object/Store Reference. Skipped.`);
            continue; // Skip flows that aren't DataObjectRef <-> Activity
        }

        const assocType  = /output/i.test(f.type)
                           ? 'DataOutputAssociation'
                           : 'DataInputAssociation';

        const assoc = moddle.create(`bpmn:${assocType}`, { id: f.id }); // Create association element

        if (assocType === 'DataInputAssociation') {
            // DataObjectReference -> Activity (visually/JSON source->target)
            // Association is nested IN the Activity and points back to the DataObjectReference
            assoc.sourceRef = dataObjectReferenceElement; // Link the association's sourceRef to the DataObjectReference
            // Add association to the Activity's incoming data associations list
            activityElement.dataInputAssociations = activityElement.dataInputAssociations || [];
            activityElement.dataInputAssociations.push(assoc);
            console.log(`Created DataInputAssociation ${f.id}, added to ${activityElement.id}.dataInputAssociations`);

        } else { // DataOutputAssociation
            // Activity -> DataObjectReference (visually/JSON source->target)
            // Association is nested IN the Activity and points to the DataObjectReference
            assoc.targetRef = dataObjectReferenceElement; // Link the association's targetRef to the DataObjectReference
            // Add association to the Activity's outgoing data associations list
            activityElement.dataOutputAssociations = activityElement.dataOutputAssociations || [];
            activityElement.dataOutputAssociations.push(assoc);
             console.log(`Created DataOutputAssociation ${f.id}, added to ${activityElement.id}.dataOutputAssociations`);
        }

        // Store the created bpmn: association element and original flow spec for DI
        byId[assoc.id] = assoc;
        dataAssociationSpecs.push({
            id: f.id,
            assocElement: assoc,
            visualSourceId: f.source, // Use JSON source for visual direction
            visualTargetId: f.target  // Use JSON target for visual direction
        });

        // Do NOT add data associations to currentProcessEl.flowElements - they are nested
        // Do NOT call wire for data associations - it uses incoming/outgoing inappropriately
        continue;
      }

      /* normal sequence flow */
      const seq = moddle.create('bpmn:SequenceFlow', {
        id:        f.id,
        name:      f.condition || '',
        sourceRef: src,
        targetRef: tgt,
        ...(f.condition && {
          conditionExpression: moddle.create('bpmn:FormalExpression', { body: f.condition })
        })
      });
      currentProcessEl.flowElements.push(seq); // Add sequence flow to the process
      wire(seq, src, tgt); // Use wire for sequence flows
      byId[seq.id] = seq;
    }
  }

/* 7 ─── DI: auto‑layout each process individually ─────────────── */
const diagram = moddle.create('bpmndi:BPMNDiagram', { id: 'Diagram_1' });
const plane   = moddle.create('bpmndi:BPMNPlane',  { id: 'Plane_1', bpmnElement: collaboration, planeElement: [] });

diagram.set('plane', plane);
definitions.set('diagrams', [diagram]);

let yOffset = 0;
// Map to store bpmndi:BPMNShape elements by their bpmnElement ID after layout
const shapeById = {};

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
    const bpmnElementId = el.bpmnElement.id; // ID of the referenced bpmn: element
    const bpmnElement = byId[bpmnElementId]; // Get the actual bpmn: element from our map

    if (!bpmnElement) {
       console.warn(`⚠️ Layout produced DI for unknown BPMN element: ${bpmnElementId}. Skipped.`);
       return;
    }

    if (el.$type === 'bpmndi:BPMNShape') {
      const newShape = moddle.create('bpmndi:BPMNShape', {
          id:          `${el.id}_g`, // Use original DI ID + suffix
          bpmnElement: bpmnElement, // Link to the actual bpmn: element object
          bounds:      moddle.create('dc:Bounds', copyBounds(el.bounds, LEFT_POOL_PADDING, yOffset))
      });
      plane.planeElement.push(newShape);
      shapeById[bpmnElementId] = newShape; // Store the new shape by the bpmn: element ID

    } else if (el.$type === 'bpmndi:BPMNEdge' && el.bpmnElement.$type === 'bpmn:SequenceFlow') {
      // Only copy sequence flow edges from the per-process layout
      const newEdge = moddle.create('bpmndi:BPMNEdge', {
          id:          `${el.id}_g`, // Use original DI ID + suffix
          bpmnElement: bpmnElement, // Link to the actual bpmn: sequence flow element object
          waypoint: copyWaypoints(el.waypoint, LEFT_POOL_PADDING, yOffset)
                      .map(pt => moddle.create('dc:Point', pt))
      });
      plane.planeElement.push(newEdge);
      // Don't add edge DI to shapeById map
    }
  });

  /* participant (pool) */
  const participant = moddle.create('bpmn:Participant', {
    id:         `Part_${pool.id}`,
    name:       pool.name,
    processRef: proc
  });
  collaboration.participants.push(participant);

  /* bounding box for this pool - account for extra LEFT padding */
  const nodeShapes = plane.planeElement.filter(
    // Find shapes *just added* for this pool's nodes
    s => s.$type === 'bpmndi:BPMNShape' && pool.nodes.some(n => n.id === s.bpmnElement.id)
  );
  if (nodeShapes.length > 0) {
      const minX = Math.min(...nodeShapes.map(s => s.bounds.x)) - (30 + LEFT_POOL_PADDING); // Add left padding back for pool bounds calc
      const minY = Math.min(...nodeShapes.map(s => s.bounds.y)) - 30;
      const maxX = Math.max(...nodeShapes.map(s => s.bounds.x + s.bounds.width)) + 30;
      const maxY = Math.max(...nodeShapes.map(s => s.bounds.y + s.bounds.height)) + 30;

      const poolShape = moddle.create('bpmndi:BPMNShape', {
          id:          `Part_${pool.id}_di`,
          bpmnElement: participant,
          isHorizontal: true,
          bounds: moddle.create('dc:Bounds', {
              x:      minX,
              y:      minY,
              width:  maxX - minX,
              height: maxY - minY
          })
      });
      plane.planeElement.unshift(poolShape); // Add pool shape at the beginning
      shapeById[participant.id] = poolShape; // Store pool shape too (though not needed for data assoc)

      yOffset = maxY + POOL_SPACING; // vertical offset for next pool
  } else {
      // Handle empty pool case if necessary
      yOffset += 100 + POOL_SPACING; // Assume minimum pool height if no nodes
  }
}

/* 8 ─── message flows + DI edges with proper docking ─────────── */
// shapeById map is populated now, use it

for (const mf of messageFlowSpecs) {
  const srcBpmn = byId[mf.source]; // bpmn: element
  const tgtBpmn = byId[mf.target]; // bpmn: element

  if (!srcBpmn || !tgtBpmn) {
    console.warn(`⚠️  Message flow ${mf.id} references unknown node(s). Skipped.`);
    continue;
  }

  // Create the bpmn:MessageFlow element
  const msgFlow = moddle.create('bpmn:MessageFlow', {
    id:        mf.id,
    name:      mf.name ?? mf.condition ?? '',
    sourceRef: srcBpmn,
    targetRef: tgtBpmn
  });
  collaboration.messageFlows.push(msgFlow);
  // wire(msgFlow, srcBpmn, tgtBpmn); // Message flows don't usually use incoming/outgoing on elements
  byId[msgFlow.id] = msgFlow; // Store the bpmn: element

  // Create the bpmndi:BPMNEdge element
  const srcShape = shapeById[srcBpmn.id]; // Get the shape for the source bpmn: element
  const tgtShape = shapeById[tgtBpmn.id]; // Get the shape for the target bpmn: element

  if (srcShape && tgtShape) {
    const start = dockPoint(srcShape, tgtShape); // Dock on source shape towards target
    const end   = dockPoint(tgtShape, srcShape); // Dock on target shape towards source

    plane.planeElement.push(
      moddle.create('bpmndi:BPMNEdge', {
        id:          `${mf.id}_di`,
        bpmnElement: msgFlow, // Link to the bpmn:MessageFlow element
        waypoint: [start, end].map(pt => moddle.create('dc:Point', pt))
      })
    );
     console.log(`✅ Created DI edge for message flow ${mf.id}`);
  } else {
      console.warn(`⚠️ Message flow ${mf.id}: Could not find DI shapes for source (${mf.source}) or target (${mf.target}). Cannot create DI edge.`);
  }
}
/* 8.5 ─── data association flows + DI edges with proper docking ─── */
// shapeById map is populated now, use it

// Keep track of Data Objects we've already repositioned
const repositionedDataObjects = new Set();

// Prioritize repositioning Data Objects based on Output Associations first.
// If not positioned by an Output, attempt to position based on an Input.
// Iterate through data association specs to decide Data Object positions.
for (const daSpec of dataAssociationSpecs) {
    const assocElement = daSpec.assocElement; // The bpmn:Data...Association element
    const visualSourceBpmn = byId[daSpec.visualSourceId]; // bpmn: element defined as visual source
    const visualTargetBpmn = byId[daSpec.visualTargetId]; // bpmn: element defined as visual target

    let doBpmnElement, activityBpmnElement;

    // Identify which element is the Data Object and which is the Activity based on the association type and source/target
    const isOutput = assocElement.$type === 'bpmn:DataOutputAssociation';
    const isInput = assocElement.$type === 'bpmn:DataInputAssociation';

    const srcIsActivity = visualSourceBpmn.$type.includes('Activity') || visualSourceBpmn.$type.includes('Task') || visualSourceBpmn.$type.includes('SubProcess') || visualSourceBpmn.$type.includes('CallActivity');
    const tgtIsActivity = visualTargetBpmn.$type.includes('Activity') || visualTargetBpmn.$type.includes('Task') || visualTargetBpmn.$type.includes('SubProcess') || visualTargetBpmn.$type.includes('CallActivity');
    const srcIsDataObject = visualSourceBpmn.$type === 'bpmn:DataObjectReference' || visualSourceBpmn.$type === 'bpmn:DataStoreReference';
    const tgtIsDataObject = visualTargetBpmn.$type === 'bpmn:DataObjectReference' || visualTargetBpmn.$type === 'bpmn:DataStoreReference';


    if ((isOutput && srcIsActivity && tgtIsDataObject)) {
        activityBpmnElement = visualSourceBpmn;
        doBpmnElement = visualTargetBpmn;
    } else if ((isInput && srcIsDataObject && tgtIsActivity)) {
        activityBpmnElement = visualTargetBpmn; // Activity is the target for input
        doBpmnElement = visualSourceBpmn;     // Data Object is the source for input
    } else {
         console.warn(`⚠️ Data association ${daSpec.id}: Source/Target types mismatch for association type. Skipping repositioning.`);
         continue;
    }

    const doShape = shapeById[doBpmnElement.id];
    const activityShape = shapeById[activityBpmnElement.id];

    if (!doShape || !activityShape) {
         console.warn(`⚠️ Data association ${daSpec.id}: Could not find DI shapes for elements. Skipping repositioning.`);
         continue;
    }

    // --- Repositioning Logic ---
    let shouldReposition = false;
    let targetX, targetY;
    const actBounds = activityShape.bounds;
    const doBounds = doShape.bounds;

    // Rule 1: If this is an Output Association and the DO hasn't been positioned yet
    if (isOutput && !repositionedDataObjects.has(doBpmnElement.id)) {
        // Place Data Object below the source Activity
        targetX = actBounds.x + (actBounds.width / 2) - (doBounds.width / 2) + DATA_OBJECT_H_GAP;
        targetY = actBounds.y + actBounds.height + DATA_OBJECT_V_GAP;
        shouldReposition = true;
        console.log(`✨ Planning reposition of ${doBpmnElement.id} below Activity ${activityBpmnElement.id} (from DOA)`);
    }
    // Rule 2: If this is an Input Association and the DO hasn't been positioned by ANY association yet
    // We only apply this rule if the DO was NOT positioned by an Output Association in a previous iteration of this loop.
    else if (isInput && !repositionedDataObjects.has(doBpmnElement.id)) {
        // Place Data Object below the target Activity (same logic as output for consistency)
        targetX = actBounds.x + (actBounds.width / 2) - (doBounds.width / 2) + DATA_OBJECT_H_GAP;
        targetY = actBounds.y + actBounds.height + DATA_OBJECT_V_GAP;
         shouldReposition = true;
         console.log(`✨ Planning reposition of ${doBpmnElement.id} below Activity ${activityBpmnElement.id} (from DIA, fallback)`);
    }
    // else: Data Object already positioned (either by a previous Output or Input rule), do not reposition again.


    if (shouldReposition) {
        // Apply the planned position
        doShape.bounds.x = targetX;
        doShape.bounds.y = targetY;
        repositionedDataObjects.add(doBpmnElement.id); // Mark as repositioned
        console.log(`-> Applied reposition for ${doBpmnElement.id}`);
    }
}

// Now, create the DI edges for ALL data associations (Input and Output),
// using the potentially updated shape positions stored in shapeById.
for (const daSpec of dataAssociationSpecs) {
    const assocElement = daSpec.assocElement; // The bpmn:Data...Association element
    const visualSourceBpmn = byId[daSpec.visualSourceId]; // bpmn: element defined as visual source
    const visualTargetBpmn = byId[daSpec.visualTargetId]; // bpmn: element defined as visual target

    if (!assocElement || !visualSourceBpmn || !visualTargetBpmn) {
       console.warn(`⚠️ Data association ${daSpec.id}: BPMN elements not found for DI edge. Skipped.`);
       continue;
    }

    // Get the DI shapes for the visual source and target elements
    // These shapes now hold the potentially updated positions for Data Objects from the previous loop
    const visualSourceShape = shapeById[visualSourceBpmn.id];
    const visualTargetShape = shapeById[visualTargetBpmn.id];

    if (visualSourceShape && visualTargetShape) {
      // Data associations typically go from Activity -> DataObjectReference (Output)
      // or from DataObjectReference -> Activity (Input) visually.
      // The 'visualSourceId' and 'visualTargetId' match this visual direction.
      // Use the potentially updated shape bounds via dockPoint.

      const start = dockPoint(visualSourceShape, visualTargetShape); // Dock on visual source shape towards visual target shape
      const end   = dockPoint(visualTargetShape, visualSourceShape); // Dock on visual target shape towards visual source shape

      plane.planeElement.push(
        moddle.create('bpmndi:BPMNEdge', {
          id:          `${daSpec.id}_di`,
          bpmnElement: assocElement, // Link the DI edge to the bpmn:Data...Association element
          waypoint: [start, end].map(pt => moddle.create('dc:Point', pt))
        })
      );
      console.log(`✅ Created DI edge for data association ${daSpec.id}`);

    } else {
         console.warn(`⚠️ Data association ${daSpec.id}: Could not find DI shapes for visual source (${daSpec.visualSourceId}) or visual target (${daSpec.visualTargetId}) for DI edge.`);
    }
}


/* 9 ─── final serialisation + save ───────────────────────────── */
const { xml: finalXml } = await moddle.toXML(definitions, { format: true });
await fs.writeFile('diagram.bpmn', finalXml);
console.log('✅  Layouted diagram (multiple pools, data objects, associations) saved to diagram.bpmn');