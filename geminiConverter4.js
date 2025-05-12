/* converter.js — JSON ➜ BPMN 2.0 XML + DI (sequence + message + data‑associations, multi‑pool)
   prerequisites:
     npm i bpmn-moddle bpmn-auto-layout
   ensure package.json contains: "type": "module"

   Tweakable layout constants ↓↓↓
*/
/* Tweakable layout constants */
const LEFT_POOL_PADDING = 30000;  // extra gap between left pool border and first node (px)
const POOL_SPACING      = 60;  // vertical gap between pools (px)
const DATA_OBJECT_V_GAP = 50;  // vertical gap between task and data object (px)
const DATA_OBJECT_H_GAP = -130;   // Horizontal offset - keep 0 for centering below task

import { layoutProcess } from 'bpmn-auto-layout';
import BpmnModdle        from 'bpmn-moddle';
import fs                from 'node:fs/promises';

/* 1 ─── load structured JSON ──────────────────────────────────── */
const processJson = JSON.parse(
  // !!! IMPORTANT: Update this path to your actual JSON file !!!
  await fs.readFile(new URL('./processTests/gemini2.json', import.meta.url))
);

/* 2 ─── helpers ───────────────────────────────────────────────── */
const capitalize = s => s[0].toUpperCase() + s.slice(1);

/* JSON → BPMN node‑name map */
const NODE_TYPE_MAP = {
  dataobject:          'DataObjectReference',
  dataobjectreference: 'DataObjectReference',
  datastore:           'DataStoreReference'
};

// Wire function - only needed if SequenceFlows use incoming/outgoing properties
// This version is specific to SequenceFlows
function wire(flow, source, target) {
   if (flow.$type === 'bpmn:SequenceFlow') {
       (source.outgoing = source.outgoing || []).push(flow);
       (target.incoming = target.incoming || []).push(flow);
   }
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
    const sourceBounds = shape.bounds;
    const targetBounds = targetShape.bounds;

    // Check if bounds exist
    if (!sourceBounds || !targetBounds) {
        console.warn(`⚠️ dockPoint: Missing bounds for shape ${shape?.id} or ${targetShape?.id}`);
        // Fallback to center of source shape if possible, else origin
        const fallbackX = sourceBounds ? sourceBounds.x + sourceBounds.width / 2 : 0;
        const fallbackY = sourceBounds ? sourceBounds.y + sourceBounds.height / 2 : 0;
        return { x: fallbackX, y: fallbackY };
    }

    const { x, y, width, height } = sourceBounds;
    const cx = x + width / 2;
    const cy = y + height / 2;
    const tx = targetBounds.x + targetBounds.width / 2;
    const ty = targetBounds.y + targetBounds.height / 2;

    const dx = tx - cx;
    const dy = ty - cy;

    // If centers are the same, return center
    if (dx === 0 && dy === 0) return { x: cx, y: cy };

    // Calculate intersection using simplified approach (midpoint of edge)
    // Determine primary direction (horizontal or vertical)
    if (Math.abs(dx) * height > Math.abs(dy) * width) {
        // More horizontal than vertical: intersects left or right edge
        return { x: dx > 0 ? x + width : x, y: cy };
    } else {
        // More vertical than horizontal: intersects top or bottom edge
        return { x: cx, y: dy > 0 ? y + height : y };
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
// *** Keep original list name for positioning logic compatibility ***
const dataAssociationSpecs = []; // Array to store specs for DI creation


/* 5 ─── create one <Process> per pool + its nodes ─────────────── */
const processByPool = {};

for (const pool of pools) {
  const processEl = moddle.create('bpmn:Process', {
    id:           `Proc_${pool.id}`,
    name:         pool.name,
    isExecutable: true,
    flowElements: [],
    // *** ADDED: artifacts list needed for bpmn:Association ***
    artifacts: []
  });

  definitions.get('rootElements').push(processEl);
  processByPool[pool.id] = processEl;

  for (const n of pool.nodes) {
    const bpmnName = NODE_TYPE_MAP[n.type.toLowerCase()] ?? capitalize(n.type);
    const el = moddle.create(`bpmn:${bpmnName}`, {
      id:   n.id,
      name: n.name,
      ...(n.isCollection != null && { isCollection: n.isCollection })
    });

    if (n.eventDefinitionType) {
      const evDef = moddle.create(`bpmn:${capitalize(n.eventDefinitionType)}`, {});
      el.eventDefinitions = [ evDef ];
    }

    // Keep DOs in flowElements for layout compatibility with bpmn-auto-layout
    processEl.flowElements.push(el);
    byId[n.id]       = el;
    poolOfNode[n.id] = pool.id;
  }
}

/* 6 ─── intra‑ vs cross‑pool flows (store cross/data for later) ───── */
// *** MODIFIED SECTION TO USE bpmn:Association FOR INPUTS ***
for (const pool of pools) {
    const currentProcessEl = processByPool[pool.id];
    for (const f of pool.flows) {
        const src = byId[f.source];
        const tgt = byId[f.target];
        if (!src || !tgt) {
            console.warn(`⚠️ Flow ${f.id} references unknown node(s) ${f.source} -> ${f.target}. Skipped.`);
            continue;
        }

        const crossPool = poolOfNode[f.source] !== poolOfNode[f.target];
        const isMsgFlow = f.type === 'messageFlow';
        const isDataAssoc = /data(Input|Output)?Association/i.test(f.type);

        if (crossPool || isMsgFlow) {
            messageFlowSpecs.push(f);
            continue;
        }

        if (isDataAssoc) {
            let activityElement, dataObjectReferenceElement;
            // Determine elements based on types
            const srcIsActivity = src.$type.includes('Activity') || src.$type.includes('Task') || src.$type.includes('SubProcess') || src.$type.includes('CallActivity');
            const tgtIsActivity = tgt.$type.includes('Activity') || tgt.$type.includes('Task') || tgt.$type.includes('SubProcess') || tgt.$type.includes('CallActivity');
            const srcIsDataObject = src.$type === 'bpmn:DataObjectReference' || src.$type === 'bpmn:DataStoreReference';
            const tgtIsDataObject = tgt.$type === 'bpmn:DataObjectReference' || tgt.$type === 'bpmn:DataStoreReference';

            let isVisuallyInput = false; // Is the JSON flow DO -> Activity?

            if (srcIsActivity && tgtIsDataObject) {
                activityElement = src;
                dataObjectReferenceElement = tgt;
                isVisuallyInput = false; // JSON: Activity -> DO
            } else if (srcIsDataObject && tgtIsActivity) {
                activityElement = tgt; // The Activity is the target semantically for Input
                dataObjectReferenceElement = src;
                isVisuallyInput = true; // JSON: DO -> Activity
            } else {
                console.warn(`⚠️ Data association ${f.id}: Does not connect an Activity and a Data Object/Store Reference. Skipped.`);
                continue;
            }

            // --- Modification Point: Create correct BPMN element ---
            let assocElement; // This will hold the created bpmn: element
            if (isVisuallyInput) {
                // *** WORKAROUND: Create bpmn:Association for visual input flow ***
                console.log(`🌀 WORKAROUND: Creating bpmn:Association for ${f.id} (visual input)`);
                assocElement = moddle.create('bpmn:Association', {
                     id: f.id,
                     sourceRef: dataObjectReferenceElement, // Semantic source (DO)
                     targetRef: activityElement,            // Semantic target (Activity)
                     associationDirection: "One"             // Indicate direction DO -> Activity
                 });
                // Add to process artifacts list
                currentProcessEl.artifacts = currentProcessEl.artifacts || [];
                currentProcessEl.artifacts.push(assocElement);
                // NOTE: We do NOT add this to activityElement.dataInputAssociations

            } else { // Visually Output: Activity -> DO
                // *** Keep original logic: Create DataOutputAssociation ***
                console.log(`✅ Creating bpmn:DataOutputAssociation for ${f.id} (visual output)`);
                assocElement = moddle.create(`bpmn:DataOutputAssociation`, { id: f.id });
                // Link targetRef (the DO)
                assocElement.targetRef = dataObjectReferenceElement;
                // Add association to the Activity's outgoing list (sourceRef is implicit)
                activityElement.dataOutputAssociations = activityElement.dataOutputAssociations || [];
                activityElement.dataOutputAssociations.push(assocElement);
            }
            // --- End Modification Point ---

            // Store the created element (either Association or DataOutputAssociation) in byId map
            byId[assocElement.id] = assocElement;
            // Store the spec using the ORIGINAL list name for positioning logic compatibility
            dataAssociationSpecs.push({
                id: f.id,                   // Original flow ID
                assocElement: assocElement, // The actual bpmn:* object created
                visualSourceId: f.source,   // Visual source from JSON
                visualTargetId: f.target    // Visual target from JSON
            });
            continue; // Skip sequence flow part
        }

        /* normal sequence flow */
        const seq = moddle.create('bpmn:SequenceFlow', {
            id:        f.id,
            name:      f.name || f.condition || '',
            sourceRef: src,
            targetRef: tgt,
            ...(f.condition && {
                conditionExpression: moddle.create('bpmn:FormalExpression', { body: f.condition })
            })
        });
        currentProcessEl.flowElements.push(seq);
        wire(seq, src, tgt); // Call wire only for sequence flows
        byId[seq.id] = seq;
    }
}

/* 7 ─── DI: auto‑layout each process individually ─────────────── */
// *** Using the version with Temp Collaboration/Participant for layout ***
const diagram = moddle.create('bpmndi:BPMNDiagram', { id: 'Diagram_1' });
const plane   = moddle.create('bpmndi:BPMNPlane',  { id: 'Plane_1', bpmnElement: collaboration, planeElement: [] });
diagram.set('plane', plane);
definitions.set('diagrams', [diagram]);

let yOffset = 0;
const shapeById = {}; // Map BPMN element ID -> its bpmndi:BPMNShape

for (const pool of pools) {
    const proc = processByPool[pool.id];

    // Create temporary Collaboration and Participant for the layout process
    const tmpCollaboration = moddle.create('bpmn:Collaboration', { id: `Tmp_Collab_${pool.id}` });
    const tmpParticipant = moddle.create('bpmn:Participant', {
        id: `Tmp_Part_${pool.id}`,
        processRef: proc // Link temp participant to the actual process
    });
    tmpCollaboration.get('participants').push(tmpParticipant);

    // Create temporary Definitions containing the temp Collaboration and the Process
    const tmpDefs = moddle.create('bpmn:Definitions', {
        id:              `Tmp_Defs_${pool.id}`,
        targetNamespace: 'http://example.com/bpmn',
        rootElements:    [tmpCollaboration, proc] // Layout needs both
    });

    const { xml: tmpXml } = await moddle.toXML(tmpDefs);
    let laidXml;
    try {
        console.log(`⏳ Running layout for pool ${pool.id}...`);
        laidXml = await layoutProcess(tmpXml);
        console.log(`✅ Layout finished for pool ${pool.id}.`);
    } catch (error) {
        console.error(`❌ Error during layout for pool ${pool.id}:`, error);
        console.error("--- Problematic XML for Layout --- \n", tmpXml, "\n--- End Problematic XML ---");
        yOffset += 100 + POOL_SPACING; // Add space and skip this pool's DI
        continue;
    }

    // Parse the layout result
    let laidDefs;
    try {
        const fromXmlResult = await moddle.fromXML(laidXml, { lax: true });
        laidDefs = fromXmlResult.rootElement;
        if (fromXmlResult.warnings && fromXmlResult.warnings.length > 0) {
            console.warn(`⚠️ Moddle warnings reading laid out XML for pool ${pool.id}:`, fromXmlResult.warnings);
        }
    } catch (parseError) {
        console.error(`❌ Error parsing laid out XML for pool ${pool.id}:`, parseError);
        console.error("--- Laid Out XML --- \n", laidXml, "\n--- End Laid Out XML ---");
        yOffset += 100 + POOL_SPACING;
        continue;
    }

    if (!laidDefs?.diagrams?.[0]?.plane) {
       console.error(`❌ Failed to find plane in parsed layout result for pool ${pool.id}. Skipping DI elements.`);
       yOffset += 100 + POOL_SPACING;
       continue;
    }
    const laidPlane = laidDefs.diagrams[0].plane;

    /* copy shapes and sequence flow edges into main plane, applying offset */
    console.log(`↳ Copying DI elements for pool ${pool.id}...`);
    laidPlane.planeElement.forEach(el => {
        // Skip the temporary participant shape itself
        if (el.bpmnElement && el.bpmnElement.id === `Tmp_Part_${pool.id}`) {
            return;
        }

        const bpmnElementId = el.bpmnElement?.id;
        // Find the *original* BPMN element object from our main 'byId' map
        const originalBpmnElement = bpmnElementId ? byId[bpmnElementId] : null;

        if (!originalBpmnElement) {
            // Ignore DI for elements not in our original map (e.g., the process itself sometimes appears)
            if (!bpmnElementId || !bpmnElementId.startsWith(`Proc_${pool.id}`)) {
               console.warn(`⚠️ Layout DI references unknown element: ${bpmnElementId || el.id}. Skipped.`);
            }
           return;
        }

        // Handle Shapes
        if (el.bounds && el.$type === 'bpmndi:BPMNShape') {
            const newShape = moddle.create('bpmndi:BPMNShape', {
                id:          `${el.id}_g`, // Ensure unique DI ID
                bpmnElement: originalBpmnElement, // Link to the actual original bpmn:* object
                bounds:      moddle.create('dc:Bounds', copyBounds(el.bounds, LEFT_POOL_PADDING, yOffset)),
                // Copy other relevant DI attributes if needed (e.g., isHorizontal for SubProcess)
                ...(typeof el.isHorizontal === 'boolean' && {isHorizontal: el.isHorizontal}),
                 ...(typeof el.isMarkerVisible === 'boolean' && {isMarkerVisible: el.isMarkerVisible}),
                 ...(typeof el.isExpanded === 'boolean' && {isExpanded: el.isExpanded}) // Important for SubProcess
            });
            plane.planeElement.push(newShape);
            shapeById[bpmnElementId] = newShape; // Store the created shape keyed by the BPMN element's ID
        }
        // Handle Sequence Flow Edges ONLY (ignore association edges from layout)
        else if (el.waypoint && el.$type === 'bpmndi:BPMNEdge' && originalBpmnElement.$type === 'bpmn:SequenceFlow') {
             const newEdge = moddle.create('bpmndi:BPMNEdge', {
                 id:          `${el.id}_g`,
                 bpmnElement: originalBpmnElement,
                 waypoint: copyWaypoints(el.waypoint, LEFT_POOL_PADDING, yOffset)
                             .map(pt => moddle.create('dc:Point', pt))
             });
             plane.planeElement.push(newEdge);
        }
    });

    /* participant (pool shape) */
    const participant = moddle.create('bpmn:Participant', {
        id:         `Part_${pool.id}`,
        name:       pool.name,
        processRef: proc // Link participant to the actual process
    });
    collaboration.participants.push(participant);
    byId[participant.id] = participant; // Store participant element as well

    /* bounding box for this pool */
    // Filter shapes belonging to THIS pool's nodes that we just added to the plane
    const nodeShapesInPool = plane.planeElement.filter( s =>
        s.$type === 'bpmndi:BPMNShape' &&
        pool.nodes.some(n => n.id === s.bpmnElement.id) && // Belongs to a node in this pool
        s.id.endsWith('_g') // Ensure it's one we just added (avoids double counting if script runs weirdly)
    );

    if (nodeShapesInPool.length > 0) {
        const minX = Math.min(...nodeShapesInPool.map(s => s.bounds.x));
        const minY = Math.min(...nodeShapesInPool.map(s => s.bounds.y));
        const maxX = Math.max(...nodeShapesInPool.map(s => s.bounds.x + s.bounds.width));
        const maxY = Math.max(...nodeShapesInPool.map(s => s.bounds.y + s.bounds.height));

        const poolPadding = 30; // Visual padding inside pool boundaries
        const poolHeaderWidth = 30; // Space for the vertical pool label

        const poolShape = moddle.create('bpmndi:BPMNShape', {
            id:          `Part_${pool.id}_di`,
            bpmnElement: participant, // Link to the bpmn:Participant element
            isHorizontal: true,       // Pools are horizontal lanes
            bounds: moddle.create('dc:Bounds', {
                x:      minX - poolHeaderWidth, // Start left for label
                y:      minY - poolPadding,
                width:  (maxX - minX) + poolHeaderWidth + poolPadding, // Total width needed
                height: (maxY - minY) + (2 * poolPadding)          // Total height needed
            })
        });
        plane.planeElement.unshift(poolShape); // Add pool shape before its contents
        shapeById[participant.id] = poolShape; // Store pool shape

        // Update yOffset for the next pool based on the bottom of this pool shape
        yOffset = poolShape.bounds.y + poolShape.bounds.height + POOL_SPACING;
    } else {
        console.warn(`⚠️ Pool ${pool.id} has no layouted nodes. Creating default participant shape.`);
        // Create a default minimal pool shape if no nodes were layouted
        const poolShape = moddle.create('bpmndi:BPMNShape', {
            id:          `Part_${pool.id}_di`,
            bpmnElement: participant,
            isHorizontal: true,
            bounds: moddle.create('dc:Bounds', { x: 0, y: yOffset, width: 600, height: 100 }) // Default size
        });
        plane.planeElement.unshift(poolShape);
        shapeById[participant.id] = poolShape;
        yOffset += 100 + POOL_SPACING; // Move down by default height + spacing
    }
}


/* 8 ─── message flows + DI edges ─────────── */
console.log('\n--- Creating Message Flow Edges ---');
for (const mf of messageFlowSpecs) {
    const srcBpmn = byId[mf.source];
    const tgtBpmn = byId[mf.target];

    if (!srcBpmn || !tgtBpmn) {
        console.warn(`⚠️ Message flow ${mf.id} references unknown node(s) ${mf.source} -> ${mf.target}. Skipped.`);
        continue;
    }

    // Create the bpmn:MessageFlow element
    const msgFlow = moddle.create('bpmn:MessageFlow', {
        id:        mf.id,
        name:      mf.name ?? mf.condition ?? '',
        sourceRef: srcBpmn, // Link to the actual source node (Task, Event, etc.)
        targetRef: tgtBpmn  // Link to the actual target node
    });
    collaboration.messageFlows.push(msgFlow);
    byId[msgFlow.id] = msgFlow; // Store the message flow element

    // Create the bpmndi:BPMNEdge
    const srcShape = shapeById[srcBpmn.id]; // Shape of the source node
    const tgtShape = shapeById[tgtBpmn.id]; // Shape of the target node

    if (srcShape && tgtShape) {
         // Check for bounds before docking
        if (!srcShape.bounds || !tgtShape.bounds) {
             console.warn(`⚠️ Message flow ${mf.id}: Missing bounds on source or target shape for docking. Skipping DI edge.`);
             continue;
        }
        const start = dockPoint(srcShape, tgtShape);
        const end   = dockPoint(tgtShape, srcShape);
        // Check if docking produced valid points
        if (isNaN(start.x) || isNaN(start.y) || isNaN(end.x) || isNaN(end.y)) {
            console.warn(`⚠️ Message flow ${mf.id}: Invalid docking points calculated (${JSON.stringify(start)}, ${JSON.stringify(end)}). Skipping DI edge.`);
            continue;
        }
        plane.planeElement.push(
            moddle.create('bpmndi:BPMNEdge', {
                id:          `${mf.id}_di`,
                bpmnElement: msgFlow, // Link DI edge to the bpmn:MessageFlow
                waypoint: [start, end].map(pt => moddle.create('dc:Point', pt))
            })
        );
        console.log(`✅ Created DI edge for message flow ${mf.id}`);
    } else {
        console.warn(`⚠️ Message flow ${mf.id}: Could not find DI shapes for source (${mf.source}) or target (${mf.target}). Cannot create DI edge.`);
    }
}


/* 8.5 ─── data association flows + DI edges ──────────────── */
// *** Using the original positioning logic from user's code ***
// *** Adapted Edge Creation to link to correct bpmn element ***

const repositionedDataObjects = new Set();

// --- Repositioning Pass (User's Original Logic Structure) ---
console.log('\n--- Repositioning Data Objects (Based on First Encounter) ---');
for (const daSpec of dataAssociationSpecs) { // Use original list name
    // Infer visual direction and intended type for positioning logic
    const visualSourceBpmn = byId[daSpec.visualSourceId];
    const visualTargetBpmn = byId[daSpec.visualTargetId];
    if (!visualSourceBpmn || !visualTargetBpmn) continue;

    let doBpmnElement, activityBpmnElement;
    let isInputBasedOnVisual = false;

    const srcIsActivity = visualSourceBpmn.$type.includes('Activity') || visualSourceBpmn.$type.includes('Task');
    const tgtIsActivity = visualTargetBpmn.$type.includes('Activity') || visualTargetBpmn.$type.includes('Task');
    const srcIsDataObject = visualSourceBpmn.$type === 'bpmn:DataObjectReference' || visualSourceBpmn.$type === 'bpmn:DataStoreReference';
    const tgtIsDataObject = visualTargetBpmn.$type === 'bpmn:DataObjectReference' || visualTargetBpmn.$type === 'bpmn:DataStoreReference';

    if (srcIsActivity && tgtIsDataObject) { // Visual: Activity -> DO
        activityBpmnElement = visualSourceBpmn;
        doBpmnElement = visualTargetBpmn;
        isInputBasedOnVisual = false;
    } else if (srcIsDataObject && tgtIsActivity) { // Visual: DO -> Activity
        activityBpmnElement = visualTargetBpmn; // Anchor position calculation to the activity
        doBpmnElement = visualSourceBpmn;
        isInputBasedOnVisual = true;
    } else {
         console.warn(`⚠️ Data association spec ${daSpec.id}: Cannot determine Activity/DO from visual nodes. Skipping repositioning.`);
         continue;
    }

    // Ensure elements were identified
    if (!doBpmnElement || !activityBpmnElement) {
        console.warn(`⚠️ Data association spec ${daSpec.id}: Failed to identify DO or Activity element. Skipping repositioning.`);
        continue;
    }

    const doShape = shapeById[doBpmnElement.id];
    const activityShape = shapeById[activityBpmnElement.id]; // Use activity identified from visual flow

    if (!doShape || !activityShape) {
         console.warn(`⚠️ Data association spec ${daSpec.id}: Could not find DI shape for DO (${doBpmnElement.id}) or Activity (${activityBpmnElement.id}). Skipping repositioning.`);
         continue;
    }
    if (!doShape.bounds || !activityShape.bounds) {
       console.warn(`⚠️ Data association spec ${daSpec.id}: Missing bounds on DI shape for DO or Activity. Skipping repositioning.`);
       continue;
    }

    // Check if already positioned by a previous spec for this DO
    if (repositionedDataObjects.has(doBpmnElement.id)) {
        // console.log(`-> DO ${doBpmnElement.id} already positioned. Skipping spec ${daSpec.id}.`); // Optional log
        continue;
    }

    // --- Repositioning Logic (Apply based on the *first* association found for the DO) ---
    let shouldReposition = false;
    let targetX, targetY;
    const actBounds = activityShape.bounds;
    const doBounds = doShape.bounds;

    // Apply rule based on first encounter (matches original logic's effect)
    targetX = actBounds.x + (actBounds.width / 2) - (doBounds.width / 2) + DATA_OBJECT_H_GAP;
    targetY = actBounds.y + actBounds.height + DATA_OBJECT_V_GAP;
    shouldReposition = true; // Always try to reposition if not already done
    console.log(`✨ Planning reposition of ${doBpmnElement.id} below Activity ${activityBpmnElement.id} (based on spec ${daSpec.id})`);


    if (shouldReposition) {
        doShape.bounds.x = targetX;
        doShape.bounds.y = targetY;
        repositionedDataObjects.add(doBpmnElement.id); // Mark as repositioned
        console.log(`-> Applied reposition for ${doBpmnElement.id}. New bounds: x=${targetX.toFixed(1)}, y=${targetY.toFixed(1)}`);
    }
}
console.log('--- Finished Repositioning ---');


// --- Edge Creation Pass ---
// *** MODIFIED PART: Ensure edge links to the correct BPMN element ***
console.log('\n--- Creating Association Edges ---');
for (const daSpec of dataAssociationSpecs) { // Iterate original list
    // *** Get the ACTUAL element we created (Assoc or DataOutputAssoc) from byId map ***
    const actualAssocElement = byId[daSpec.id]; // Use the spec's original flow ID (f.id)
    const visualSourceBpmn = byId[daSpec.visualSourceId];
    const visualTargetBpmn = byId[daSpec.visualTargetId];

    if (!actualAssocElement) {
       console.warn(`⚠️ Data association ${daSpec.id}: Could not find created BPMN Association element in byId map. Skipping DI edge.`);
       continue;
    }
     if (!visualSourceBpmn || !visualTargetBpmn) {
       console.warn(`⚠️ Data association ${daSpec.id}: Visual source or target BPMN element not found. Skipping DI edge.`);
       continue;
    }

    const visualSourceShape = shapeById[visualSourceBpmn.id];
    const visualTargetShape = shapeById[visualTargetBpmn.id];

    if (visualSourceShape && visualTargetShape) {
        // Check for bounds before docking
        if (!visualSourceShape.bounds || !visualTargetShape.bounds) {
             console.warn(`⚠️ Data association ${daSpec.id}: Missing bounds on source or target shape for docking. Skipping DI edge.`);
             continue;
        }
        const start = dockPoint(visualSourceShape, visualTargetShape);
        const end   = dockPoint(visualTargetShape, visualSourceShape);
        // Check if docking produced valid points
        if (isNaN(start.x) || isNaN(start.y) || isNaN(end.x) || isNaN(end.y)) {
            console.warn(`⚠️ Data association ${daSpec.id}: Invalid docking points calculated (${JSON.stringify(start)}, ${JSON.stringify(end)}). Skipping DI edge.`);
            continue;
        }

        plane.planeElement.push(
            moddle.create('bpmndi:BPMNEdge', {
                id:          `${daSpec.id}_di`,
                // *** CRITICAL: Link edge to the ACTUAL Association/DataOutputAssociation element ***
                bpmnElement: actualAssocElement,
                waypoint: [start, end].map(pt => moddle.create('dc:Point', pt))
            })
        );
        // Log the type of the element the edge is linked to
        console.log(`✅ Created DI edge for data association ${daSpec.id} (linked to ${actualAssocElement.$type})`);

    } else {
         console.warn(`⚠️ Data association ${daSpec.id}: Could not find DI shapes for visual source (${daSpec.visualSourceId}) or target (${daSpec.visualTargetId}). Cannot create DI edge.`);
    }
}
console.log('--- Finished Creating Association Edges ---');


/* 9 ─── final serialisation + save ───────────────────────────── */
console.log('\nSerializing final BPMN XML...');
const { xml: finalXml } = await moddle.toXML(definitions, { format: true });
const outputPath = 'diagram.bpmn'; // Define output path
await fs.writeFile(outputPath, finalXml);
console.log(`✅ Layouted diagram (workaround applied) saved to ${outputPath}`);