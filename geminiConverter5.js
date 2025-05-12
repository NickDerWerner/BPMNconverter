/* converter.js — JSON ➜ BPMN 2.0 XML + DI (sequence + message + data‑associations, multi‑pool)
   prerequisites:
     npm i bpmn-moddle bpmn-auto-layout
   ensure package.json contains: "type": "module"

   Tweakable layout constants ↓↓↓
*/
/* Tweakable layout constants */
const LEFT_POOL_PADDING = 500;   // <<< ADJUSTED FOR VISIBILITY DURING TESTING, use your 30000 if needed >>> // extra gap between diagram left edge and pool border (px)
const POOL_HEADER_WIDTH = 30;   // Space for the vertical pool label (px)
const POOL_INTERNAL_PADDING_LEFT = 50; // Gap between pool header and first node (px) - ADJUST AS NEEDED
const POOL_INTERNAL_PADDING_OTHER = 30; // Visual padding inside pool boundaries (top, bottom, right) (px)
const POOL_SPACING      = 60;   // vertical gap between pools (px)
const DATA_OBJECT_V_GAP = 50;   // vertical gap between task and data object (px)
const DATA_OBJECT_H_GAP = 0;  // Horizontal offset - keep 0 for centering below task

import { layoutProcess } from 'bpmn-auto-layout';
import BpmnModdle        from 'bpmn-moddle';
import fs                from 'node:fs/promises';

/* 1 ─── load structured JSON ──────────────────────────────────── */
const processJson = JSON.parse(
  // !!! IMPORTANT: Update this path to your actual JSON file !!!
  // await fs.readFile(new URL('./processTests/gemini2.json', import.meta.url)) // Example
  await fs.readFile(new URL('./processTests/gemini2.json', import.meta.url)) // <<< --- !!! UPDATE THIS !!!
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
// *** MODIFIED: Removed default offsets, they will be calculated separately ***
const copyBounds = (src) => ({
  x: src.x,
  y: src.y,
  width: src.width,
  height: src.height
});

const copyWaypoints = (wps) =>
  wps.map(wp => ({ x: wp.x, y: wp.y }));

/* compute a docking point on the border of a shape in the direction of target */
function dockPoint(shape, targetShape) {
    const sourceBounds = shape.bounds;
    const targetBounds = targetShape.bounds;

    // Check if bounds exist
    if (!sourceBounds || !targetBounds) {
        console.warn(`⚠️ dockPoint: Missing bounds for shape ${shape?.id} or ${targetShape?.id}`);
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

    if (dx === 0 && dy === 0) return { x: cx, y: cy };

    if (Math.abs(dx) * height > Math.abs(dy) * width) {
        return { x: dx > 0 ? x + width : x, y: cy };
    } else {
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
const dataAssociationSpecs = [];


/* 5 ─── create one <Process> per pool + its nodes ─────────────── */
const processByPool = {};

for (const pool of pools) {
  const processEl = moddle.create('bpmn:Process', {
    id:           `Proc_${pool.id}`,
    name:         pool.name,
    isExecutable: true,
    flowElements: [],
    artifacts: [] // Needed for bpmn:Association
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

    processEl.flowElements.push(el);
    byId[n.id]       = el;
    poolOfNode[n.id] = pool.id;
  }
}

/* 6 ─── intra‑ vs cross‑pool flows (store cross/data for later) ───── */
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
            const srcIsActivity = src.$type.includes('Activity') || src.$type.includes('Task') || src.$type.includes('SubProcess') || src.$type.includes('CallActivity');
            const tgtIsActivity = tgt.$type.includes('Activity') || tgt.$type.includes('Task') || tgt.$type.includes('SubProcess') || tgt.$type.includes('CallActivity');
            const srcIsDataObject = src.$type === 'bpmn:DataObjectReference' || src.$type === 'bpmn:DataStoreReference';
            const tgtIsDataObject = tgt.$type === 'bpmn:DataObjectReference' || tgt.$type === 'bpmn:DataStoreReference';

            let isVisuallyInput = false;

            if (srcIsActivity && tgtIsDataObject) {
                activityElement = src;
                dataObjectReferenceElement = tgt;
                isVisuallyInput = false;
            } else if (srcIsDataObject && tgtIsActivity) {
                activityElement = tgt;
                dataObjectReferenceElement = src;
                isVisuallyInput = true;
            } else {
                console.warn(`⚠️ Data association ${f.id}: Does not connect an Activity and a Data Object/Store Reference. Skipped.`);
                continue;
            }

            let assocElement;
            if (isVisuallyInput) {
                console.log(`🌀 WORKAROUND: Creating bpmn:Association for ${f.id} (visual input)`);
                assocElement = moddle.create('bpmn:Association', {
                     id: f.id,
                     sourceRef: dataObjectReferenceElement,
                     targetRef: activityElement,
                     associationDirection: "One"
                 });
                currentProcessEl.artifacts = currentProcessEl.artifacts || [];
                currentProcessEl.artifacts.push(assocElement);
            } else {
                console.log(`✅ Creating bpmn:DataOutputAssociation for ${f.id} (visual output)`);
                assocElement = moddle.create(`bpmn:DataOutputAssociation`, { id: f.id });
                assocElement.targetRef = dataObjectReferenceElement;
                activityElement.dataOutputAssociations = activityElement.dataOutputAssociations || [];
                activityElement.dataOutputAssociations.push(assocElement);
            }
            byId[assocElement.id] = assocElement;
            dataAssociationSpecs.push({
                id: f.id,
                assocElement: assocElement,
                visualSourceId: f.source,
                visualTargetId: f.target
            });
            continue;
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
        wire(seq, src, tgt);
        byId[seq.id] = seq;
    }
}

/* 7 ─── DI: auto‑layout each process individually ─────────────── */
// *** MODIFIED SECTION FOR CORRECT PADDING ***
const diagram = moddle.create('bpmndi:BPMNDiagram', { id: 'Diagram_1' });
const plane   = moddle.create('bpmndi:BPMNPlane',  { id: 'Plane_1', bpmnElement: collaboration, planeElement: [] });
diagram.set('plane', plane);
definitions.set('diagrams', [diagram]);

let yOffset = 0;
const shapeById = {}; // Map BPMN element ID -> its bpmndi:BPMNShape

for (const pool of pools) {
    const proc = processByPool[pool.id];

    // Create temporary structure for layout
    const tmpCollaboration = moddle.create('bpmn:Collaboration', { id: `Tmp_Collab_${pool.id}` });
    const tmpParticipant = moddle.create('bpmn:Participant', {
        id: `Tmp_Part_${pool.id}`,
        processRef: proc
    });
    tmpCollaboration.get('participants').push(tmpParticipant);
    const tmpDefs = moddle.create('bpmn:Definitions', {
        id:              `Tmp_Defs_${pool.id}`,
        targetNamespace: 'http://example.com/bpmn',
        rootElements:    [tmpCollaboration, proc]
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

    // --- Store raw layout results and calculate bounds ---
    const rawLayoutElements = [];
    let minLayoutX = Infinity, maxLayoutX = -Infinity;
    let minLayoutY = Infinity, maxLayoutY = -Infinity;
    let hasElements = false;

    console.log(`↳ Processing layout results for pool ${pool.id}...`);
    laidPlane.planeElement.forEach(el => {
        // Skip the temporary participant shape and elements without a bpmnElement
        if (!el.bpmnElement || el.bpmnElement.id === `Tmp_Part_${pool.id}`) {
            return;
        }

        const bpmnElementId = el.bpmnElement.id;
        const originalBpmnElement = byId[bpmnElementId];

        if (!originalBpmnElement) {
            if (!bpmnElementId || !bpmnElementId.startsWith(`Proc_${pool.id}`)) {
               console.warn(`⚠️ Layout DI references unknown element: ${bpmnElementId || el.id}. Skipped.`);
            }
           return;
        }

        // Store raw data and track bounds (only for shapes)
        if (el.bounds && el.$type === 'bpmndi:BPMNShape') {
            const bounds = copyBounds(el.bounds); // Use raw bounds
            rawLayoutElements.push({ type: 'shape', element: originalBpmnElement, rawBounds: bounds, diAttribs: el });
            minLayoutX = Math.min(minLayoutX, bounds.x);
            maxLayoutX = Math.max(maxLayoutX, bounds.x + bounds.width);
            minLayoutY = Math.min(minLayoutY, bounds.y);
            maxLayoutY = Math.max(maxLayoutY, bounds.y + bounds.height);
            hasElements = true;
        }
        // Store raw data for sequence flow edges ONLY
        else if (el.waypoint && el.$type === 'bpmndi:BPMNEdge' && originalBpmnElement.$type === 'bpmn:SequenceFlow') {
             rawLayoutElements.push({ type: 'edge', element: originalBpmnElement, rawWaypoints: copyWaypoints(el.waypoint) });
        }
    });

    /* participant (pool) element */
    const participant = moddle.create('bpmn:Participant', {
        id:         `Part_${pool.id}`,
        name:       pool.name,
        processRef: proc
    });
    collaboration.participants.push(participant);
    byId[participant.id] = participant;

    /* participant (pool shape) DI element */
    let poolShape;
    let finalNodeXOffset = LEFT_POOL_PADDING + POOL_HEADER_WIDTH; // Default offset if no elements
    let poolHeight = 100; // Default height

    if (hasElements) {
        console.log(`  Raw layout bounds for ${pool.id}: X[${minLayoutX.toFixed(1)}..${maxLayoutX.toFixed(1)}], Y[${minLayoutY.toFixed(1)}..${maxLayoutY.toFixed(1)}]`);

        const poolContentWidth = maxLayoutX - minLayoutX;
        const poolContentHeight = maxLayoutY - minLayoutY;

        const finalPoolX = LEFT_POOL_PADDING; // Pool starts at the desired padding
        const finalPoolY = minLayoutY + yOffset - POOL_INTERNAL_PADDING_OTHER; // Position top edge based on content + yOffset + padding

        // Calculate offset needed to place nodes inside the pool, after the header
        // Target X for the first node = finalPoolX + POOL_HEADER_WIDTH + POOL_INTERNAL_PADDING_LEFT
        // Current X for the first node (relative to layout) = minLayoutX
        // Offset needed = Target X - Current X
        finalNodeXOffset = finalPoolX + POOL_HEADER_WIDTH + POOL_INTERNAL_PADDING_LEFT - minLayoutX;

        poolHeight = poolContentHeight + (2 * POOL_INTERNAL_PADDING_OTHER);
        const poolWidth = POOL_HEADER_WIDTH + POOL_INTERNAL_PADDING_LEFT + poolContentWidth + POOL_INTERNAL_PADDING_OTHER;

        poolShape = moddle.create('bpmndi:BPMNShape', {
            id:          `Part_${pool.id}_di`,
            bpmnElement: participant,
            isHorizontal: true,
            bounds: moddle.create('dc:Bounds', {
                x:      finalPoolX,
                y:      finalPoolY,
                width:  poolWidth,
                height: poolHeight
            })
        });
        console.log(`  Pool ${pool.id} shape: x=${finalPoolX.toFixed(1)}, y=${finalPoolY.toFixed(1)}, w=${poolWidth.toFixed(1)}, h=${poolHeight.toFixed(1)}`);
        console.log(`  Calculated Node X Offset for ${pool.id}: ${finalNodeXOffset.toFixed(1)}`);

    } else {
        console.warn(`⚠️ Pool ${pool.id} has no layouted nodes. Creating default participant shape.`);
        poolShape = moddle.create('bpmndi:BPMNShape', {
            id:          `Part_${pool.id}_di`,
            bpmnElement: participant,
            isHorizontal: true,
            bounds: moddle.create('dc:Bounds', {
                 x: LEFT_POOL_PADDING, // Start at padding
                 y: yOffset,
                 width: 600, // Default size
                 height: poolHeight
            })
        });
        // No need to adjust finalNodeXOffset here, the default is fine if there are no nodes
    }

    plane.planeElement.unshift(poolShape); // Add pool shape first
    shapeById[participant.id] = poolShape;

    // --- Create final DI for nodes and edges using calculated offsets ---
    console.log(`↳ Creating final DI elements for pool ${pool.id} with offsets...`);
    rawLayoutElements.forEach(item => {
        const element = item.element;
        const elementId = element.id;

        if (item.type === 'shape') {
            const finalBounds = moddle.create('dc:Bounds', {
                 x: item.rawBounds.x + finalNodeXOffset, // Apply calculated X offset
                 y: item.rawBounds.y + yOffset,          // Apply Y offset
                 width: item.rawBounds.width,
                 height: item.rawBounds.height
             });

            const newShape = moddle.create('bpmndi:BPMNShape', {
                id:          `${elementId}_di`, // Use original element ID + suffix for DI ID
                bpmnElement: element,
                bounds:      finalBounds,
                // Copy other relevant DI attributes from original layout result (item.diAttribs)
                 ...(typeof item.diAttribs.isHorizontal === 'boolean' && {isHorizontal: item.diAttribs.isHorizontal}),
                 ...(typeof item.diAttribs.isMarkerVisible === 'boolean' && {isMarkerVisible: item.diAttribs.isMarkerVisible}),
                 ...(typeof item.diAttribs.isExpanded === 'boolean' && {isExpanded: item.diAttribs.isExpanded})
            });
            plane.planeElement.push(newShape);
            shapeById[elementId] = newShape;
        }
        else if (item.type === 'edge') {
            const finalWaypoints = item.rawWaypoints.map(wp => moddle.create('dc:Point', {
                x: wp.x + finalNodeXOffset, // Apply calculated X offset
                y: wp.y + yOffset           // Apply Y offset
            }));

            const newEdge = moddle.create('bpmndi:BPMNEdge', {
                 id:          `${elementId}_di`, // Use original element ID + suffix for DI ID
                 bpmnElement: element,
                 waypoint:    finalWaypoints
             });
             plane.planeElement.push(newEdge);
        }
    });

    // Update yOffset for the next pool
    yOffset = poolShape.bounds.y + poolShape.bounds.height + POOL_SPACING;
    console.log(`  Next pool yOffset: ${yOffset.toFixed(1)}`);
} // End of pool loop


/* 8 ─── message flows + DI edges ─────────── */
console.log('\n--- Creating Message Flow Edges ---');
for (const mf of messageFlowSpecs) {
    const srcBpmn = byId[mf.source];
    const tgtBpmn = byId[mf.target];

    if (!srcBpmn || !tgtBpmn) {
        console.warn(`⚠️ Message flow ${mf.id} references unknown node(s) ${mf.source} -> ${mf.target}. Skipped.`);
        continue;
    }

    const msgFlow = moddle.create('bpmn:MessageFlow', {
        id:        mf.id,
        name:      mf.name ?? mf.condition ?? '',
        sourceRef: srcBpmn,
        targetRef: tgtBpmn
    });
    collaboration.messageFlows.push(msgFlow);
    byId[msgFlow.id] = msgFlow;

    const srcShape = shapeById[srcBpmn.id];
    const tgtShape = shapeById[tgtBpmn.id];

    if (srcShape && tgtShape) {
        if (!srcShape.bounds || !tgtShape.bounds) {
             console.warn(`⚠️ Message flow ${mf.id}: Missing bounds on source or target shape for docking. Skipping DI edge.`);
             continue;
        }
        const start = dockPoint(srcShape, tgtShape);
        const end   = dockPoint(tgtShape, srcShape);
        if (isNaN(start.x) || isNaN(start.y) || isNaN(end.x) || isNaN(end.y)) {
            console.warn(`⚠️ Message flow ${mf.id}: Invalid docking points calculated (${JSON.stringify(start)}, ${JSON.stringify(end)}). Skipping DI edge.`);
            continue;
        }
        plane.planeElement.push(
            moddle.create('bpmndi:BPMNEdge', {
                id:          `${mf.id}_di`,
                bpmnElement: msgFlow,
                waypoint: [start, end].map(pt => moddle.create('dc:Point', pt))
            })
        );
        console.log(`✅ Created DI edge for message flow ${mf.id}`);
    } else {
        console.warn(`⚠️ Message flow ${mf.id}: Could not find DI shapes for source (${mf.source}) or target (${mf.target}). Cannot create DI edge.`);
    }
}


/* 8.5 ─── data association flows + DI edges ──────────────── */
// *** This section uses the repositioning logic based on the FINAL node positions ***
const repositionedDataObjects = new Set();

console.log('\n--- Repositioning Data Objects (Based on First Encounter) ---');
for (const daSpec of dataAssociationSpecs) {
    const visualSourceBpmn = byId[daSpec.visualSourceId];
    const visualTargetBpmn = byId[daSpec.visualTargetId];
    if (!visualSourceBpmn || !visualTargetBpmn) continue;

    let doBpmnElement, activityBpmnElement;
    const srcIsActivity = visualSourceBpmn.$type.includes('Activity') || visualSourceBpmn.$type.includes('Task');
    const tgtIsDataObject = visualTargetBpmn.$type === 'bpmn:DataObjectReference' || visualTargetBpmn.$type === 'bpmn:DataStoreReference';
    const srcIsDataObject = visualSourceBpmn.$type === 'bpmn:DataObjectReference' || visualSourceBpmn.$type === 'bpmn:DataStoreReference';
    const tgtIsActivity = visualTargetBpmn.$type.includes('Activity') || visualTargetBpmn.$type.includes('Task');

    if (srcIsActivity && tgtIsDataObject) {
        activityBpmnElement = visualSourceBpmn;
        doBpmnElement = visualTargetBpmn;
    } else if (srcIsDataObject && tgtIsActivity) {
        activityBpmnElement = visualTargetBpmn;
        doBpmnElement = visualSourceBpmn;
    } else {
         console.warn(`⚠️ Data association spec ${daSpec.id}: Cannot determine Activity/DO from visual nodes. Skipping repositioning.`);
         continue;
    }
    if (!doBpmnElement || !activityBpmnElement) {
        console.warn(`⚠️ Data association spec ${daSpec.id}: Failed to identify DO or Activity element. Skipping repositioning.`);
        continue;
    }

    const doShape = shapeById[doBpmnElement.id];
    const activityShape = shapeById[activityBpmnElement.id];

    if (!doShape || !activityShape) {
         console.warn(`⚠️ Data association spec ${daSpec.id}: Could not find DI shape for DO (${doBpmnElement.id}) or Activity (${activityBpmnElement.id}). Skipping repositioning.`);
         continue;
    }
    if (!doShape.bounds || !activityShape.bounds) {
       console.warn(`⚠️ Data association spec ${daSpec.id}: Missing bounds on DI shape for DO or Activity. Skipping repositioning.`);
       continue;
    }
    if (repositionedDataObjects.has(doBpmnElement.id)) {
        continue;
    }

    // --- Repositioning Logic (Apply based on the *first* association found for the DO) ---
    const actBounds = activityShape.bounds; // These bounds ALREADY include the final offsets
    const doBounds = doShape.bounds;
    const targetX = actBounds.x + (actBounds.width / 2) - (doBounds.width / 2) + DATA_OBJECT_H_GAP;
    const targetY = actBounds.y + actBounds.height + DATA_OBJECT_V_GAP;

    console.log(`✨ Planning reposition of ${doBpmnElement.id} below Activity ${activityBpmnElement.id} (based on spec ${daSpec.id})`);
    doShape.bounds.x = targetX;
    doShape.bounds.y = targetY;
    repositionedDataObjects.add(doBpmnElement.id); // Mark as repositioned
    console.log(`-> Applied reposition for ${doBpmnElement.id}. New bounds: x=${targetX.toFixed(1)}, y=${targetY.toFixed(1)}`);
}
console.log('--- Finished Repositioning ---');


// --- Edge Creation Pass ---
console.log('\n--- Creating Association Edges ---');
for (const daSpec of dataAssociationSpecs) {
    const actualAssocElement = byId[daSpec.id];
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

    // Get shapes using the VISUAL source/target IDs
    const visualSourceShape = shapeById[visualSourceBpmn.id];
    const visualTargetShape = shapeById[visualTargetBpmn.id];

    if (visualSourceShape && visualTargetShape) {
        // Use the potentially repositioned bounds for docking
        if (!visualSourceShape.bounds || !visualTargetShape.bounds) {
             console.warn(`⚠️ Data association ${daSpec.id}: Missing bounds on source or target shape for docking. Skipping DI edge.`);
             continue;
        }
        const start = dockPoint(visualSourceShape, visualTargetShape);
        const end   = dockPoint(visualTargetShape, visualSourceShape);
        if (isNaN(start.x) || isNaN(start.y) || isNaN(end.x) || isNaN(end.y)) {
            console.warn(`⚠️ Data association ${daSpec.id}: Invalid docking points calculated (${JSON.stringify(start)}, ${JSON.stringify(end)}). Skipping DI edge.`);
            continue;
        }

        plane.planeElement.push(
            moddle.create('bpmndi:BPMNEdge', {
                id:          `${daSpec.id}_di`,
                bpmnElement: actualAssocElement, // Link edge to the bpmn:Association or bpmn:DataOutputAssociation
                waypoint: [start, end].map(pt => moddle.create('dc:Point', pt))
            })
        );
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
console.log(`✅ Layouted diagram saved to ${outputPath}`);