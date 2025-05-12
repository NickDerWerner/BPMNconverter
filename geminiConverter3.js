/* converter.js — JSON ➜ BPMN 2.0 XML + DI (sequence + message + data‑associations, multi‑pool)
   prerequisites:
     npm i bpmn-moddle bpmn-auto-layout
   ensure package.json contains: "type": "module"

   Tweakable layout constants ↓↓↓
*/
/* Tweakable layout constants */
const LEFT_POOL_PADDING = 30;  // extra gap between left pool border and first node (px)
const POOL_SPACING      = 60;  // vertical gap between pools (px)
const DATA_OBJECT_V_GAP = 0;  // vertical gap between task and data object (px)
const DATA_OBJECT_H_GAP = 0;   // Horizontal offset - keep 0 for centering below task

import { layoutProcess } from 'bpmn-auto-layout';
import BpmnModdle        from 'bpmn-moddle';
import fs                from 'node:fs/promises';

/* 1 ─── load structured JSON ──────────────────────────────────── */
const processJson = JSON.parse(
  await fs.readFile(new URL('processTests/gemini2.json', import.meta.url))
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
    // Only used for SequenceFlows now
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
  // Need actual shape bounds, not just the bpmnElement
  const sourceBounds = shape.bounds;
  const targetBounds = targetShape.bounds;

  if (!sourceBounds || !targetBounds) {
      console.warn(`⚠️ dockPoint: Missing bounds for shape ${shape?.id} or ${targetShape?.id}`);
      return { x: 0, y: 0 }; // Fallback
  }

  const { x, y, width, height } = sourceBounds;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const tx = targetBounds.x + targetBounds.width / 2;
  const ty = targetBounds.y + targetBounds.height / 2;

  const dx = tx - cx;
  const dy = ty - cy;

  // Handle case where shapes might overlap or be identical
  if (dx === 0 && dy === 0) {
      return { x: x + width / 2, y: y + height / 2 }; // Center point as fallback
  }

  if (Math.abs(dx) * height > Math.abs(dy) * width) {
    // Intersects left or right edge
    return { x: dx > 0 ? x + width : x, y: cy + dy * (width / 2) / Math.abs(dx) };
  } else {
    // Intersects top or bottom edge
    return { x: cx + dx * (height / 2) / Math.abs(dy), y: dy > 0 ? y + height : y };
  }
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
// Store specs for Associations and DataOutputAssociations for DI creation
const associationLikeSpecs = [];


/* 5 ─── create one <Process> per pool + its nodes ─────────────── */
const processByPool = {};

for (const pool of pools) {
  const processEl = moddle.create('bpmn:Process', {
    id:           `Proc_${pool.id}`,
    name:         pool.name,
    isExecutable: true,
    flowElements: [],
    artifacts: [] // Initialize artifacts list for Associations
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
      // We create DataObjectRefs directly as per the JSON input.
    });

    /* optional eventDefinitionType */
    if (n.eventDefinitionType) {
      const evDef = moddle.create(`bpmn:${capitalize(n.eventDefinitionType)}`, {});
      el.eventDefinitions = [ evDef ];
    }

    // Add flow elements (Activities, Events, Gateways) to flowElements
    // Add Artifacts (DataObjectReference, DataStoreReference) to artifacts
    // Note: Technically DataObjectRef *can* be a flowElement, but often treated as Artifact.
    // Let's add them to flowElements for now as the auto-layouter expects them there.
    // If layout issues occur, moving them to processEl.artifacts might be needed,
    // but would require adjusting the layout logic.
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
      const isDataAssoc = /data(input|output)?Association/i.test(f.type); // Match input/output ignoring case

      if (crossPool || isMsgFlow) {
        messageFlowSpecs.push(f);
        continue;
      }

      if (isDataAssoc) {
        /* Data Associations: Use bpmn:Association for input, bpmn:DataOutputAssociation for output */
        let activityElement, dataObjectReferenceElement;
        let isInputFlow = false; // Determine if it's visually Input (DO -> Activity)

        // Determine which element is the Activity and which is the Data Object/Store Reference
        const srcIsActivity = src.$type.includes('Activity') || src.$type.includes('Task') || src.$type.includes('SubProcess') || src.$type.includes('CallActivity');
        const tgtIsActivity = tgt.$type.includes('Activity') || tgt.$type.includes('Task') || tgt.$type.includes('SubProcess') || tgt.$type.includes('CallActivity');
        const srcIsDataObject = src.$type === 'bpmn:DataObjectReference' || src.$type === 'bpmn:DataStoreReference';
        const tgtIsDataObject = tgt.$type === 'bpmn:DataObjectReference' || tgt.$type === 'bpmn:DataStoreReference';

        if (srcIsActivity && tgtIsDataObject) {
            // Visually: Activity -> DataObject (Output)
            activityElement = src;
            dataObjectReferenceElement = tgt;
            isInputFlow = false;
        } else if (srcIsDataObject && tgtIsActivity) {
            // Visually: DataObject -> Activity (Input)
            activityElement = tgt;
            dataObjectReferenceElement = src;
            isInputFlow = true;
        } else {
            console.warn(`⚠️ Data association ${f.id}: Does not connect an Activity and a Data Object/Store Reference. Skipped.`);
            continue;
        }

        // --- WORKAROUND ---
        // Use bpmn:Association for INPUT flows (DO -> Activity)
        // Use bpmn:DataOutputAssociation for OUTPUT flows (Activity -> DO)
        let associationElement;
        if (isInputFlow) {
            // Create bpmn:Association
            console.log(`🌀 Using bpmn:Association (Workaround) for Input Flow ${f.id}`);
            associationElement = moddle.create('bpmn:Association', {
                id: f.id,
                sourceRef: dataObjectReferenceElement, // Source is DO
                targetRef: activityElement,            // Target is Activity
                associationDirection: "One"             // Direction DO -> Activity
            });
            // Add to process artifacts list
            currentProcessEl.artifacts = currentProcessEl.artifacts || [];
            currentProcessEl.artifacts.push(associationElement);
        } else {
            // Create standard bpmn:DataOutputAssociation
            console.log(`✅ Using bpmn:DataOutputAssociation for Output Flow ${f.id}`);
            associationElement = moddle.create('bpmn:DataOutputAssociation', {
                 id: f.id
                 // targetRef will be set below, sourceRef is implicit (the activity it's nested in)
                 });
            // Link the association's targetRef to the DataObjectReference
            associationElement.targetRef = dataObjectReferenceElement;
            // Add association to the Activity's outgoing data associations list
            activityElement.dataOutputAssociations = activityElement.dataOutputAssociations || [];
            activityElement.dataOutputAssociations.push(associationElement);
        }
        // --- End Workaround ---

        // Store the created bpmn: association element and original flow spec for DI
        byId[associationElement.id] = associationElement;
        associationLikeSpecs.push({
            id: f.id,
            assocElement: associationElement, // Could be bpmn:Association or bpmn:DataOutputAssociation
            visualSourceId: f.source, // Use JSON source for visual direction
            visualTargetId: f.target  // Use JSON target for visual direction
        });

        // Do NOT add these association types to currentProcessEl.flowElements
        // Do NOT call wire for data/general associations
        continue;
      }

      /* normal sequence flow */
      const seq = moddle.create('bpmn:SequenceFlow', {
        id:        f.id,
        name:      f.name || f.condition || '', // Use name if present, fallback to condition
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

  /* temp defs containing only THIS process + needed collaboration/participants for layout */
   // Create a temporary collaboration shell just for layout
   const tmpCollaboration = moddle.create('bpmn:Collaboration', { id: `Tmp_Collab_${pool.id}` });
   const tmpParticipant = moddle.create('bpmn:Participant', {
       id: `Tmp_Part_${pool.id}`,
       processRef: proc
   });
   tmpCollaboration.get('participants').push(tmpParticipant);

  const tmpDefs = moddle.create('bpmn:Definitions', {
    id:              `Tmp_Defs_${pool.id}`,
    targetNamespace: 'http://example.com/bpmn',
    // Layout needs the Collaboration and the Process
    rootElements:    [tmpCollaboration, proc]
  });

  const { xml: tmpXml } = await moddle.toXML(tmpDefs);
  // console.log(`--- Temp XML for Layout (${pool.id}) ---\n${tmpXml}\n------------------`); // Debugging

  let laidXml;
  try {
      laidXml = await layoutProcess(tmpXml);
  } catch (error) {
      console.error(`❌ Error during layout for pool ${pool.id}:`, error);
      console.error("Problematic XML:", tmpXml);
      // Decide how to proceed: skip pool, use dummy layout, etc.
      // For now, we'll just skip adding DI elements for this pool.
      yOffset += 100 + POOL_SPACING; // Add some space and continue
      continue;
  }
    // console.log(`--- Laid XML (${pool.id}) ---\n${laidXml}\n------------------`); // Debugging


  const { rootElement: laidDefs, warnings } = await moddle.fromXML(laidXml, { lax: true });

  if (warnings && warnings.length > 0) {
      console.warn(`⚠️ Moddle warnings reading laid out XML for pool ${pool.id}:`, warnings);
  }

  if (!laidDefs || !laidDefs.diagrams || laidDefs.diagrams.length === 0 || !laidDefs.diagrams[0].plane) {
      console.error(`❌ Failed to parse layout result or find plane for pool ${pool.id}. Skipping DI elements.`);
      yOffset += 100 + POOL_SPACING; // Add some space and continue
      continue;
  }

  const laidPlane = laidDefs.diagrams[0].plane;

  /* copy shapes and edges into main plane, offset vertically + LEFT padding */
  laidPlane.planeElement.forEach(el => {
    // Skip the temporary participant shape from layout result
    if (el.bpmnElement && el.bpmnElement.id === `Tmp_Part_${pool.id}`) {
        return;
    }

    // Find the *original* BPMN element from our main 'byId' map
    const bpmnElementId = el.bpmnElement ? el.bpmnElement.id : null;
    const originalBpmnElement = bpmnElementId ? byId[bpmnElementId] : null;

    if (!originalBpmnElement) {
       // This might be the process element itself in some layouts, ignore if so.
       // Or it could be an intermediate element created by the layouter.
       if (!bpmnElementId || !bpmnElementId.startsWith(`Proc_${pool.id}`)) {
         console.warn(`⚠️ Layout produced DI for unknown or unexpected BPMN element: ${bpmnElementId || el.id}. Skipped.`);
       }
       return;
    }

     // Ensure bounds exist before copying
     if (el.bounds && el.$type === 'bpmndi:BPMNShape') {
      const newShape = moddle.create('bpmndi:BPMNShape', {
          id:          `${el.id}_g`, // Use original DI ID + suffix
          bpmnElement: originalBpmnElement, // Link to the ACTUAL bpmn: element object
          bounds:      moddle.create('dc:Bounds', copyBounds(el.bounds, LEFT_POOL_PADDING, yOffset))
          // Copy other relevant attributes like isHorizontal if needed (esp. for pools/lanes)
          // ...(el.isHorizontal !== undefined && {isHorizontal: el.isHorizontal})
      });
      plane.planeElement.push(newShape);
      shapeById[bpmnElementId] = newShape; // Store the new shape by the bpmn: element ID

    } else if (el.waypoint && el.$type === 'bpmndi:BPMNEdge' && originalBpmnElement.$type === 'bpmn:SequenceFlow') {
      // Only copy sequence flow edges from the per-process layout
      const newEdge = moddle.create('bpmndi:BPMNEdge', {
          id:          `${el.id}_g`, // Use original DI ID + suffix
          bpmnElement: originalBpmnElement, // Link to the actual bpmn: sequence flow element object
          waypoint: copyWaypoints(el.waypoint, LEFT_POOL_PADDING, yOffset)
                      .map(pt => moddle.create('dc:Point', pt))
      });
      plane.planeElement.push(newEdge);
      // Don't add edge DI to shapeById map
    }
     // Ignore other edge types (like data associations) from the individual layout result
  });

  /* participant (pool) */
  const participant = moddle.create('bpmn:Participant', {
    id:         `Part_${pool.id}`,
    name:       pool.name,
    processRef: proc
  });
  collaboration.participants.push(participant);
  byId[participant.id] = participant; // Add participant to byId map

  /* bounding box for this pool - account for extra LEFT padding */
  const nodeShapes = plane.planeElement.filter(
    // Find shapes *just added* for this pool's nodes
    s => s.$type === 'bpmndi:BPMNShape' && pool.nodes.some(n => n.id === s.bpmnElement.id)
  );
  if (nodeShapes.length > 0) {
      // Calculate bounds based on the *copied and offset* shapes
      const minX = Math.min(...nodeShapes.map(s => s.bounds.x));
      const minY = Math.min(...nodeShapes.map(s => s.bounds.y));
      const maxX = Math.max(...nodeShapes.map(s => s.bounds.x + s.bounds.width));
      const maxY = Math.max(...nodeShapes.map(s => s.bounds.y + s.bounds.height));

      // Pool shape bounds calculation needs adjustments for visual padding
      const poolPadding = 30; // Standard visual padding around nodes within a pool
      const poolHeaderWidth = 30; // Standard width of the pool header (label area)

      const poolShape = moddle.create('bpmndi:BPMNShape', {
          id:          `Part_${pool.id}_di`,
          bpmnElement: participant, // Link to the main participant
          isHorizontal: true,
          bounds: moddle.create('dc:Bounds', {
              x:      minX - poolPadding - LEFT_POOL_PADDING, // Adjust for node padding AND the extra left padding we added
              y:      minY - poolPadding,
              width:  (maxX - minX) + (2 * poolPadding) + LEFT_POOL_PADDING, // Add back left padding here
              height: (maxY - minY) + (2 * poolPadding)
          })
      });
      plane.planeElement.unshift(poolShape); // Add pool shape at the beginning
      shapeById[participant.id] = poolShape; // Store pool shape too

      yOffset = poolShape.bounds.y + poolShape.bounds.height + POOL_SPACING; // Use pool bounds for next offset
  } else {
      // Handle empty pool case: Create a participant but maybe a default small shape?
        const poolShape = moddle.create('bpmndi:BPMNShape', {
            id:          `Part_${pool.id}_di`,
            bpmnElement: participant,
            isHorizontal: true,
            bounds: moddle.create('dc:Bounds', { x: 0, y: yOffset, width: 400, height: 100 }) // Default size
        });
        plane.planeElement.unshift(poolShape);
        shapeById[participant.id] = poolShape;
        console.warn(`⚠️ Pool ${pool.id} has no nodes with shapes, created default pool shape.`);
        yOffset += 100 + POOL_SPACING; // Add default height + spacing
  }
}


/* 8 ─── message flows + DI edges with proper docking ─────────── */
// shapeById map is populated now, use it

for (const mf of messageFlowSpecs) {
  const srcBpmn = byId[mf.source]; // bpmn: element
  const tgtBpmn = byId[mf.target]; // bpmn: element

  if (!srcBpmn || !tgtBpmn) {
    console.warn(`⚠️  Message flow ${mf.id} references unknown node(s) ${mf.source} -> ${mf.target}. Skipped.`);
    continue;
  }

   // Get the participant containing the source/target if the source/target isn't a participant itself
   const effectiveSrc = srcBpmn.$type === 'bpmn:Participant' ? srcBpmn : byId[`Part_${poolOfNode[mf.source]}`];
   const effectiveTgt = tgtBpmn.$type === 'bpmn:Participant' ? tgtBpmn : byId[`Part_${poolOfNode[mf.target]}`];

   if (!effectiveSrc || !effectiveTgt) {
      console.warn(`⚠️ Message flow ${mf.id}: Could not determine effective source/target participant. Skipped.`);
      continue;
   }

  // Create the bpmn:MessageFlow element (linking actual nodes or potentially participants)
  const msgFlow = moddle.create('bpmn:MessageFlow', {
    id:        mf.id,
    name:      mf.name ?? mf.condition ?? '',
    sourceRef: srcBpmn, // Link to the actual source node (task, event etc)
    targetRef: tgtBpmn  // Link to the actual target node
  });
  collaboration.messageFlows.push(msgFlow);
  byId[msgFlow.id] = msgFlow; // Store the bpmn: element

  // Create the bpmndi:BPMNEdge element
  // Edge visually connects the source/target *shapes* (which might be nodes or participants)
  const srcShape = shapeById[srcBpmn.id];
  const tgtShape = shapeById[tgtBpmn.id];

  if (srcShape && tgtShape) {
    const start = dockPoint(srcShape, tgtShape); // Dock on actual source shape towards actual target shape
    const end   = dockPoint(tgtShape, srcShape); // Dock on actual target shape towards actual source shape

    plane.planeElement.push(
      moddle.create('bpmndi:BPMNEdge', {
        id:          `${mf.id}_di`,
        bpmnElement: msgFlow, // Link to the bpmn:MessageFlow element
        waypoint: [start, end].map(pt => moddle.create('dc:Point', pt))
      })
    );
     console.log(`✅ Created DI edge for message flow ${mf.id}`);
  } else {
      console.warn(`⚠️ Message flow ${mf.id}: Could not find DI shapes for source (${mf.source}: ${srcBpmn.$type}) or target (${mf.target}: ${tgtBpmn.$type}). Cannot create DI edge.`);
  }
}

/* 8.5 ─── Association / Data Output Association flows + DI edges ─── */

// Helper function to check if a DO has any output association defined in the specs
function hasOutputAssociation(doId, allSpecs, byIdMap) {
    return allSpecs.some(spec => {
        const assocElement = spec.assocElement;
        // Only consider actual DataOutputAssociations for this check
        if (!assocElement || assocElement.$type !== 'bpmn:DataOutputAssociation') {
            return false;
        }
        // A DataOutputAssociation's source is the Activity, target is the DO.
        // We need to check if the target of this spec matches the doId we're interested in.
        const visualTarget = byIdMap[spec.visualTargetId];
        return visualTarget && (visualTarget.$type === 'bpmn:DataObjectReference' || visualTarget.$type === 'bpmn:DataStoreReference') && visualTarget.id === doId;
    });
}

// Keep track of Data Objects we've already repositioned
const repositionedDataObjects = new Set();

// --- Repositioning Pass ---
// Iterate to determine and apply positions. Prioritize Output Associations.
console.log('\n--- Repositioning Data Objects ---');
for (const spec of associationLikeSpecs) {
    const assocElement = spec.assocElement;
    const visualSourceBpmn = byId[spec.visualSourceId];
    const visualTargetBpmn = byId[spec.visualTargetId];

    if (!assocElement || !visualSourceBpmn || !visualTargetBpmn) continue;

    let doBpmnElement, activityBpmnElement, anchorActivityElement;
    const isOutputAssoc = assocElement.$type === 'bpmn:DataOutputAssociation';
    const isGeneralAssoc = assocElement.$type === 'bpmn:Association'; // Our workaround case

    // Identify DO and Activity involved in *this specific* association
    if (isOutputAssoc && visualSourceBpmn.$type.includes('Activity') && (visualTargetBpmn.$type === 'bpmn:DataObjectReference' || visualTargetBpmn.$type === 'bpmn:DataStoreReference')) {
        // Output flow: Activity -> DO
        activityBpmnElement = visualSourceBpmn; // Activity involved in this specific flow
        doBpmnElement = visualTargetBpmn;
        anchorActivityElement = visualSourceBpmn; // << Position relative to the SOURCE activity
         console.log(`[Spec ${spec.id} - DOA]: DO=${doBpmnElement.id}, Activity=${activityBpmnElement.id}, Anchor=${anchorActivityElement.id}`);

    } else if (isGeneralAssoc && (visualSourceBpmn.$type === 'bpmn:DataObjectReference' || visualSourceBpmn.$type === 'bpmn:DataStoreReference') && visualTargetBpmn.$type.includes('Activity')) {
        // Input flow (workaround): DO -> Activity
        activityBpmnElement = visualTargetBpmn; // Activity involved in this specific flow
        doBpmnElement = visualSourceBpmn;
        // For input, we *only* anchor if there's NO output assoc. Anchor remains the activity involved here (target).
        anchorActivityElement = visualTargetBpmn; // << Potential anchor is the TARGET activity
         console.log(`[Spec ${spec.id} - Assoc]: DO=${doBpmnElement.id}, Activity=${activityBpmnElement.id}, Potential Anchor=${anchorActivityElement.id}`);

    } else {
        console.warn(`⚠️ Association ${spec.id}: Unexpected combination or types for visual flow. Skipping repositioning check.`);
        continue; // Skip if not Activity <-> DO in expected directions for the types
    }

    // Check if already positioned
    if (repositionedDataObjects.has(doBpmnElement.id)) {
        console.log(`-> DO ${doBpmnElement.id} already repositioned. Skipping spec ${spec.id}.`);
        continue;
    }

    const doShape = shapeById[doBpmnElement.id];
    // Get the shape of the ANCHOR activity (might be different from activityBpmnElement if input assoc)
    const anchorActivityShape = shapeById[anchorActivityElement.id];

    if (!doShape || !anchorActivityShape || !doShape.bounds || !anchorActivityShape.bounds) {
         console.warn(`⚠️ Association ${spec.id}: Could not find DI shapes/bounds for DO (${doBpmnElement.id}) or Anchor Activity (${anchorActivityElement.id}). Skipping repositioning.`);
         continue;
    }

    // --- Repositioning Decision Logic ---
    let shouldReposition = false;
    let targetX, targetY;
    const anchorBounds = anchorActivityShape.bounds; // Use anchor shape bounds
    const doBounds = doShape.bounds;

    if (isOutputAssoc) {
        // If it's an Output Association, always use it to position.
        targetX = anchorBounds.x + (anchorBounds.width / 2) - (doBounds.width / 2) + DATA_OBJECT_H_GAP;
        targetY = anchorBounds.y + anchorBounds.height + DATA_OBJECT_V_GAP;
        shouldReposition = true;
        console.log(`✨ Planning reposition of ${doBpmnElement.id} below source Anchor Activity ${anchorActivityElement.id} (from DOA ${spec.id})`);
    } else if (isGeneralAssoc) {
        // If it's an Input Association (workaround), only use it for positioning
        // if the Data Object does NOT have any Output Association defined elsewhere.
        if (!hasOutputAssociation(doBpmnElement.id, associationLikeSpecs, byId)) {
            // No Output Association found for this DO, so position based on this Input association's target activity.
            targetX = anchorBounds.x + (anchorBounds.width / 2) - (doBounds.width / 2) + DATA_OBJECT_H_GAP;
            targetY = anchorBounds.y + anchorBounds.height + DATA_OBJECT_V_GAP;
            shouldReposition = true;
            console.log(`✨ Planning reposition of ${doBpmnElement.id} below target Anchor Activity ${anchorActivityElement.id} (from Association ${spec.id} - no DOA found)`);
        } else {
            // An Output Association exists, so *don't* position based on this input association.
            // The loop iteration handling the Output Association will position it (or already has).
            console.log(`-> Skipping reposition of ${doBpmnElement.id} based on Input Association ${spec.id}; an Output Association exists and will dictate position.`);
        }
    }

    if (shouldReposition) {
        // Apply the planned position
        doShape.bounds.x = targetX;
        doShape.bounds.y = targetY;
        repositionedDataObjects.add(doBpmnElement.id); // Mark as repositioned
        console.log(`-> Applied reposition for ${doBpmnElement.id} relative to Activity ${anchorActivityElement.id}`);
    }
}
console.log('--- Finished Repositioning ---');


// --- Edge Creation Pass ---
// Now, create the DI edges using the final (potentially updated) shape positions.
console.log('\n--- Creating Association Edges ---');
for (const spec of associationLikeSpecs) {
    const assocElement = spec.assocElement;
    const visualSourceBpmn = byId[spec.visualSourceId];
    const visualTargetBpmn = byId[spec.visualTargetId];

    if (!assocElement || !visualSourceBpmn || !visualTargetBpmn) {
       console.warn(`⚠️ Association ${spec.id}: BPMN elements not found for DI edge creation. Skipped.`);
       continue;
    }

    // Get the DI shapes using the final positions
    const visualSourceShape = shapeById[visualSourceBpmn.id];
    const visualTargetShape = shapeById[visualTargetBpmn.id];

    if (visualSourceShape && visualTargetShape) {
      const start = dockPoint(visualSourceShape, visualTargetShape);
      const end   = dockPoint(visualTargetShape, visualSourceShape);

      // Ensure waypoints are valid points
      if (isNaN(start.x) || isNaN(start.y) || isNaN(end.x) || isNaN(end.y)) {
            console.warn(`⚠️ Association ${spec.id}: Invalid waypoints calculated for edge (Start: ${JSON.stringify(start)}, End: ${JSON.stringify(end)}). Skipping edge creation.`);
            continue;
      }

      plane.planeElement.push(
        moddle.create('bpmndi:BPMNEdge', {
          id:          `${spec.id}_di`,
          bpmnElement: assocElement, // Link DI edge to the bpmn:Association or bpmn:DataOutputAssociation
          waypoint: [start, end].map(pt => moddle.create('dc:Point', pt))
        })
      );
      console.log(`✅ Created DI edge for association ${spec.id} (${assocElement.$type}) from ${visualSourceBpmn.id} to ${visualTargetBpmn.id}`);

    } else {
         console.warn(`⚠️ Association ${spec.id}: Could not find DI shapes for edge creation (Source Shape ID: ${visualSourceBpmn.id}, Target Shape ID: ${visualTargetBpmn.id}).`);
    }
}
console.log('--- Finished Creating Association Edges ---');


/* 9 ─── final serialisation + save ───────────────────────────── */
const { xml: finalXml } = await moddle.toXML(definitions, { format: true });
await fs.writeFile('diagram.bpmn', finalXml);
console.log('✅  Layouted diagram (workaround: bpmn:Association for input) saved to diagram_workaround.bpmn');