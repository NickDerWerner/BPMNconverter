/* converter.js — JSON ➜ BPMN 2.0 XML + DI (sequence + message + data‑associations, multi‑pool)
   prerequisites:
     npm i bpmn-moddle bpmn-auto-layout
   ensure package.json contains: "type": "module"

   Tweakable layout constants ↓↓↓
*/
/* Tweakable layout constants */
const LEFT_POOL_PADDING = 500;   // <<< ADJUSTED FOR VISIBILITY DURING TESTING >>> // extra gap between diagram left edge and pool border (px)
const POOL_HEADER_WIDTH = 30;   // Space for the vertical pool label (px)
const POOL_INTERNAL_PADDING_LEFT = 50; // Gap between pool header and first node (px)
const POOL_INTERNAL_PADDING_OTHER = 30; // Visual padding inside pool boundaries (top, bottom, right) (px)
const POOL_SPACING      = 150;   // vertical gap between pools (px)
const DATA_OBJECT_V_GAP = 50;   // vertical gap between task and data object (px)
const DATA_OBJECT_H_GAP = 0;  // Horizontal offset - keep 0 for centering below task

import { layoutProcess } from 'bpmn-auto-layout';
import BpmnModdle        from 'bpmn-moddle';
import fs                from 'node:fs/promises';

/* 1 ─── load structured JSON ──────────────────────────────────── */
const processJson = JSON.parse(
  // !!! IMPORTANT: Update this path to your actual JSON file !!!
  // await fs.readFile(new URL('./processTests/gemini2.json', import.meta.url)) // Example
  await fs.readFile(new URL('./processTests/gpto3(2p).json', import.meta.url)) // <<< --- !!! UPDATE THIS !!!
);

/* 2 ─── helpers ───────────────────────────────────────────────── */
const capitalize = s => s[0].toUpperCase() + s.slice(1);

/* JSON → BPMN node‑name map */
const NODE_TYPE_MAP = {
  dataobject:          'DataObjectReference',
  dataobjectreference: 'DataObjectReference',
  datastore:           'DataStoreReference'
};

function wire(flow, source, target) {
   if (flow.$type === 'bpmn:SequenceFlow') {
       (source.outgoing = source.outgoing || []).push(flow);
       (target.incoming = target.incoming || []).push(flow);
   }
}

const copyBounds = (src) => ({
  x: src.x, y: src.y, width: src.width, height: src.height
});

const copyWaypoints = (wps) => wps.map(wp => ({ x: wp.x, y: wp.y }));

function dockPoint(shape, targetShape) {
    const sourceBounds = shape.bounds;
    const targetBounds = targetShape.bounds;
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
const definitions = moddle.create('bpmn:Definitions', { id: 'Defs_1', targetNamespace: 'http://example.com/bpmn', rootElements: [] });
const collaboration = moddle.create('bpmn:Collaboration', { id: 'Collab_1', participants: [], messageFlows: [] });
definitions.get('rootElements').push(collaboration);

/* 4 ─── normalise pools ──────────────────────────────────── */
const pools = Array.isArray(processJson.pools)
  ? processJson.pools
  : [{ id: processJson.id ?? 'Pool_1', name: processJson.name ?? 'Pool 1', nodes: processJson.nodes ?? [], flows: processJson.flows ?? [] }];
const byId = {};
const poolOfNode = {};
const messageFlowSpecs = Array.isArray(processJson.crossFlows) ? [...processJson.crossFlows] : [];
const dataAssociationSpecs = [];

/* 5 ─── create one <Process> per pool + its nodes ─────────────── */
const processByPool = {};
for (const pool of pools) {
  const processEl = moddle.create('bpmn:Process', { id: `Proc_${pool.id}`, name: pool.name, isExecutable: true, flowElements: [], artifacts: [] });
  definitions.get('rootElements').push(processEl);
  processByPool[pool.id] = processEl;
  for (const n of pool.nodes) {
    const bpmnName = NODE_TYPE_MAP[n.type.toLowerCase()] ?? capitalize(n.type);
    const el = moddle.create(`bpmn:${bpmnName}`, { id: n.id, name: n.name, ...(n.isCollection != null && { isCollection: n.isCollection }) });
    if (n.eventDefinitionType) {
      const evDef = moddle.create(`bpmn:${capitalize(n.eventDefinitionType)}`, {});
      el.eventDefinitions = [evDef];
    }
    processEl.flowElements.push(el);
    byId[n.id] = el;
    poolOfNode[n.id] = pool.id;
  }
}

/* 6 ─── intra‑ vs cross‑pool flows ───── */
for (const pool of pools) {
    const currentProcessEl = processByPool[pool.id];
    for (const f of pool.flows) {
        const src = byId[f.source];
        const tgt = byId[f.target];
        if (!src || !tgt) { console.warn(`⚠️ Flow ${f.id} references unknown node(s) ${f.source} -> ${f.target}. Skipped.`); continue; }
        const crossPool = poolOfNode[f.source] !== poolOfNode[f.target];
        const isMsgFlow = f.type === 'messageFlow';
        const isDataAssoc = /data(Input|Output)?Association/i.test(f.type);

        // --- Handle Cross-Pool / Explicit Message Flows ---
        if (crossPool || isMsgFlow) {
            messageFlowSpecs.push(f);
            continue; // Go to next flow
        }

        // --- Handle Data Associations ---
        if (isDataAssoc) {
            let activityElement, dataObjectReferenceElement;
            const srcIsActivity = src.$type.includes('Activity') || src.$type.includes('Task') || src.$type.includes('SubProcess') || src.$type.includes('CallActivity');
            const tgtIsActivity = tgt.$type.includes('Activity') || tgt.$type.includes('Task') || tgt.$type.includes('SubProcess') || tgt.$type.includes('CallActivity');
            const srcIsDataObject = src.$type === 'bpmn:DataObjectReference' || src.$type === 'bpmn:DataStoreReference';
            const tgtIsDataObject = tgt.$type === 'bpmn:DataObjectReference' || tgt.$type === 'bpmn:DataStoreReference';
            let isVisuallyInput = false;
            if (srcIsActivity && tgtIsDataObject) { activityElement = src; dataObjectReferenceElement = tgt; isVisuallyInput = false; }
            else if (srcIsDataObject && tgtIsActivity) { activityElement = tgt; dataObjectReferenceElement = src; isVisuallyInput = true; }
            else { console.warn(`⚠️ Data association ${f.id}: Does not connect Activity and Data Object/Store. Skipped.`); continue; }
            let assocElement;
            if (isVisuallyInput) {
                console.log(`🌀 WORKAROUND: Creating bpmn:Association for ${f.id} (visual input)`);
                assocElement = moddle.create('bpmn:Association', { id: f.id, sourceRef: dataObjectReferenceElement, targetRef: activityElement, associationDirection: "One" });
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
            dataAssociationSpecs.push({ id: f.id, assocElement: assocElement, visualSourceId: f.source, visualTargetId: f.target });
            continue; // Go to next flow
        }

        // --- Handle Sequence Flows (The only remaining option) ---
        const seq = moddle.create('bpmn:SequenceFlow', {
            id: f.id,
            name: f.name || f.condition || '',
            sourceRef: src,
            targetRef: tgt,
            // *** MODIFIED: Optional: Add condition only if NOT default ***
            ...(f.condition && !f.isDefault && {
                 conditionExpression: moddle.create('bpmn:FormalExpression', { body: f.condition })
            })
        });
        currentProcessEl.flowElements.push(seq);
        wire(seq, src, tgt);
        byId[seq.id] = seq;

        // --- *** NEW: Handle Default Flow *** ---
        if (f.isDefault === true) {
            // Check if the source element type supports the 'default' attribute
            const supportedTypes = ['Gateway', 'Activity', 'Task', 'SubProcess', 'CallActivity'];
            const isSupportedSource = supportedTypes.some(type => src.$type.includes(type));

            if (isSupportedSource) {
                // Check if a default is already set
                if (src.default) {
                    console.warn(`⚠️ Source node ${src.id} (${src.$type}) already has a default flow defined (${src.default.id}). Overwriting with ${seq.id} based on JSON.`);
                }
                // Set the 'default' attribute on the SOURCE element.
                src.default = seq; // Assign the sequence flow object
                console.log(`✅ Marked flow ${seq.id} as default for source ${src.id}`);

                // Optional: Clear any condition expression if it's the default flow
                // if (seq.conditionExpression) {
                //    console.log(`   -> Note: Removing condition from default flow ${seq.id}`);
                //    delete seq.conditionExpression;
                // }
            } else {
                console.warn(`⚠️ Flow ${f.id} marked as default, but source node ${src.id} (${src.$type}) does not support the 'default' attribute. Ignored.`);
            }
        }
        // --- *** END NEW *** ---

    } // End flows loop
} // End pools loop

/* 7 ─── DI: auto‑layout each process individually ─────────────── */
const diagram = moddle.create('bpmndi:BPMNDiagram', { id: 'Diagram_1' });
const plane   = moddle.create('bpmndi:BPMNPlane',  { id: 'Plane_1', bpmnElement: collaboration, planeElement: [] });
diagram.set('plane', plane);
definitions.set('diagrams', [diagram]);
let yOffset = 0;
const shapeById = {}; // Map BPMN element ID -> its bpmndi:BPMNShape
// *** ADDED: Map to store pool shape DI elements for later adjustment ***
const poolShapeById = {}; // Map Participant ID -> its bpmndi:BPMNShape

for (const pool of pools) {
    const proc = processByPool[pool.id];
    const tmpCollaboration = moddle.create('bpmn:Collaboration', { id: `Tmp_Collab_${pool.id}` });
    const tmpParticipant = moddle.create('bpmn:Participant', { id: `Tmp_Part_${pool.id}`, processRef: proc });
    tmpCollaboration.get('participants').push(tmpParticipant);
    const tmpDefs = moddle.create('bpmn:Definitions', { id: `Tmp_Defs_${pool.id}`, targetNamespace: 'http://example.com/bpmn', rootElements: [tmpCollaboration, proc] });
    const { xml: tmpXml } = await moddle.toXML(tmpDefs);
    let laidXml;
    try {
        console.log(`⏳ Running layout for pool ${pool.id}...`);
        laidXml = await layoutProcess(tmpXml);
        console.log(`✅ Layout finished for pool ${pool.id}.`);
    } catch (error) {
        console.error(`❌ Error during layout for pool ${pool.id}:`, error);
        yOffset += 100 + POOL_SPACING; continue;
    }
    let laidDefs;
    try {
        const fromXmlResult = await moddle.fromXML(laidXml, { lax: true });
        laidDefs = fromXmlResult.rootElement;
        if (fromXmlResult.warnings?.length > 0) { console.warn(`⚠️ Moddle warnings reading layout XML for pool ${pool.id}:`, fromXmlResult.warnings); }
    } catch (parseError) {
        console.error(`❌ Error parsing laid out XML for pool ${pool.id}:`, parseError);
        yOffset += 100 + POOL_SPACING; continue;
    }
    if (!laidDefs?.diagrams?.[0]?.plane) {
       console.error(`❌ Failed to find plane in parsed layout result for pool ${pool.id}.`);
       yOffset += 100 + POOL_SPACING; continue;
    }
    const laidPlane = laidDefs.diagrams[0].plane;

    // --- Store raw layout results and calculate bounds ---
    const rawLayoutElements = [];
    let minLayoutX = Infinity, maxLayoutX = -Infinity;
    let minLayoutY = Infinity, maxLayoutY = -Infinity;
    // *** ADDED: Bounds excluding Data Objects for height calculation ***
    let minLayoutY_nonDO = Infinity, maxLayoutY_nonDO = -Infinity;
    let hasNonDOElements = false;
    let hasElements = false;

    console.log(`↳ Processing layout results for pool ${pool.id}...`);
    laidPlane.planeElement.forEach(el => {
        if (!el.bpmnElement || el.bpmnElement.id === `Tmp_Part_${pool.id}`) return;
        const bpmnElementId = el.bpmnElement.id;
        const originalBpmnElement = byId[bpmnElementId];
        if (!originalBpmnElement) {
            if (!bpmnElementId || !bpmnElementId.startsWith(`Proc_${pool.id}`)) { console.warn(`⚠️ Layout DI references unknown element: ${bpmnElementId || el.id}. Skipped.`); }
           return;
        }

        const isDataObject = originalBpmnElement.$type === 'bpmn:DataObjectReference' || originalBpmnElement.$type === 'bpmn:DataStoreReference';

        if (el.bounds && el.$type === 'bpmndi:BPMNShape') {
            const bounds = copyBounds(el.bounds);
            rawLayoutElements.push({ type: 'shape', element: originalBpmnElement, rawBounds: bounds, diAttribs: el, isDataObject });
            minLayoutX = Math.min(minLayoutX, bounds.x);
            maxLayoutX = Math.max(maxLayoutX, bounds.x + bounds.width);
            minLayoutY = Math.min(minLayoutY, bounds.y); // Overall min Y for positioning
            maxLayoutY = Math.max(maxLayoutY, bounds.y + bounds.height); // Overall max Y (might be DO)
            hasElements = true;
            // *** Store non-DO bounds separately ***
            if (!isDataObject) {
                minLayoutY_nonDO = Math.min(minLayoutY_nonDO, bounds.y);
                maxLayoutY_nonDO = Math.max(maxLayoutY_nonDO, bounds.y + bounds.height);
                hasNonDOElements = true;
            }
        } else if (el.waypoint && el.$type === 'bpmndi:BPMNEdge' && originalBpmnElement.$type === 'bpmn:SequenceFlow') {
             rawLayoutElements.push({ type: 'edge', element: originalBpmnElement, rawWaypoints: copyWaypoints(el.waypoint) });
        }
    });

    /* participant (pool) element */
    const participant = moddle.create('bpmn:Participant', { id: `Part_${pool.id}`, name: pool.name, processRef: proc });
    collaboration.participants.push(participant);
    byId[participant.id] = participant;

    /* participant (pool shape) DI element */
    let poolShape;
    let finalNodeXOffset = LEFT_POOL_PADDING + POOL_HEADER_WIDTH; // Default offset
    let poolHeight = 100; // Default height

    if (hasElements) {
        console.log(`  Raw layout bounds for ${pool.id}: X[${minLayoutX.toFixed(1)}..${maxLayoutX.toFixed(1)}], Y[${minLayoutY.toFixed(1)}..${maxLayoutY.toFixed(1)}]`);
        if (hasNonDOElements) {
             console.log(`  Non-DO layout bounds for ${pool.id}: Y[${minLayoutY_nonDO.toFixed(1)}..${maxLayoutY_nonDO.toFixed(1)}]`);
        } else {
             console.log(`  Pool ${pool.id} contains only Data Objects or is empty.`);
             // Fallback to overall bounds if only DOs exist
             minLayoutY_nonDO = minLayoutY;
             maxLayoutY_nonDO = maxLayoutY;
        }

        const poolContentWidth = maxLayoutX - minLayoutX;
        // *** Use non-DO height for initial calculation ***
        const poolContentHeight = (hasNonDOElements || hasElements) ? (maxLayoutY_nonDO - minLayoutY_nonDO) : 0; // Use calculated non-DO height or 0 if empty

        const finalPoolX = LEFT_POOL_PADDING;
        // *** Position based on overall min Y, including potential DOs at the top ***
        const finalPoolY = minLayoutY + yOffset - POOL_INTERNAL_PADDING_OTHER;

        finalNodeXOffset = finalPoolX + POOL_HEADER_WIDTH + POOL_INTERNAL_PADDING_LEFT - minLayoutX;

        // *** Calculate initial height based on non-DO content ***
        poolHeight = poolContentHeight + (2 * POOL_INTERNAL_PADDING_OTHER);
        // Ensure minimum height if content height is zero or negative (e.g., single small element)
        poolHeight = Math.max(poolHeight, 60); // Ensure a minimum sensible height

        const poolWidth = POOL_HEADER_WIDTH + POOL_INTERNAL_PADDING_LEFT + poolContentWidth + POOL_INTERNAL_PADDING_OTHER;

        poolShape = moddle.create('bpmndi:BPMNShape', {
            id:          `Part_${pool.id}_di`,
            bpmnElement: participant,
            isHorizontal: true,
            bounds: moddle.create('dc:Bounds', { x: finalPoolX, y: finalPoolY, width: poolWidth, height: poolHeight }) // Initial height
        });
        console.log(`  Pool ${pool.id} initial shape: x=${finalPoolX.toFixed(1)}, y=${finalPoolY.toFixed(1)}, w=${poolWidth.toFixed(1)}, h=${poolHeight.toFixed(1)} (based on non-DOs)`);
        console.log(`  Calculated Node X Offset for ${pool.id}: ${finalNodeXOffset.toFixed(1)}`);

    } else {
        console.warn(`⚠️ Pool ${pool.id} has no layouted nodes. Creating default participant shape.`);
        poolShape = moddle.create('bpmndi:BPMNShape', {
            id:          `Part_${pool.id}_di`,
            bpmnElement: participant,
            isHorizontal: true,
            bounds: moddle.create('dc:Bounds', { x: LEFT_POOL_PADDING, y: yOffset, width: 600, height: poolHeight })
        });
    }

    plane.planeElement.unshift(poolShape);
    shapeById[participant.id] = poolShape; // Store pool shape using participant ID as key
    poolShapeById[participant.id] = poolShape; // *** Store in dedicated map for easy lookup later ***

    // --- Create final DI for nodes and edges using calculated offsets ---
    console.log(`↳ Creating final DI elements for pool ${pool.id} with offsets...`);
    rawLayoutElements.forEach(item => {
        const element = item.element;
        const elementId = element.id;
        if (item.type === 'shape') {
            const finalBounds = moddle.create('dc:Bounds', {
                 x: item.rawBounds.x + finalNodeXOffset, y: item.rawBounds.y + yOffset,
                 width: item.rawBounds.width, height: item.rawBounds.height
             });
            const newShape = moddle.create('bpmndi:BPMNShape', {
                id: `${elementId}_di`, bpmnElement: element, bounds: finalBounds,
                 ...(typeof item.diAttribs.isHorizontal === 'boolean' && {isHorizontal: item.diAttribs.isHorizontal}),
                 ...(typeof item.diAttribs.isMarkerVisible === 'boolean' && {isMarkerVisible: item.diAttribs.isMarkerVisible}),
                 ...(typeof item.diAttribs.isExpanded === 'boolean' && {isExpanded: item.diAttribs.isExpanded})
            });
            plane.planeElement.push(newShape);
            shapeById[elementId] = newShape; // Store node shape keyed by its BPMN ID
        } else if (item.type === 'edge') {
            const finalWaypoints = item.rawWaypoints.map(wp => moddle.create('dc:Point', { x: wp.x + finalNodeXOffset, y: wp.y + yOffset }));
            const newEdge = moddle.create('bpmndi:BPMNEdge', { id: `${elementId}_di`, bpmnElement: element, waypoint: finalWaypoints });
            plane.planeElement.push(newEdge);
        }
    });

    // Update yOffset for the *next* pool based on the *initial* height
    yOffset = poolShape.bounds.y + poolShape.bounds.height + POOL_SPACING;
    console.log(`  Next pool yOffset: ${yOffset.toFixed(1)}`);
} // End of pool loop


/* 8 ─── message flows + DI edges ─────────── */
console.log('\n--- Creating Message Flow Edges ---');
for (const mf of messageFlowSpecs) {
    const srcBpmn = byId[mf.source];
    const tgtBpmn = byId[mf.target];
    if (!srcBpmn || !tgtBpmn) { console.warn(`⚠️ MF ${mf.id}: Unknown node(s) ${mf.source} -> ${mf.target}. Skipped.`); continue; }
    const msgFlow = moddle.create('bpmn:MessageFlow', { id: mf.id, name: mf.name ?? mf.condition ?? '', sourceRef: srcBpmn, targetRef: tgtBpmn });
    collaboration.messageFlows.push(msgFlow);
    byId[msgFlow.id] = msgFlow;
    const srcShape = shapeById[srcBpmn.id];
    const tgtShape = shapeById[tgtBpmn.id];
    if (srcShape && tgtShape) {
        if (!srcShape.bounds || !tgtShape.bounds) { console.warn(`⚠️ MF ${mf.id}: Missing bounds for docking. Skipping DI.`); continue; }
        const start = dockPoint(srcShape, tgtShape);
        const end   = dockPoint(tgtShape, srcShape);
        if (isNaN(start.x) || isNaN(start.y) || isNaN(end.x) || isNaN(end.y)) { console.warn(`⚠️ MF ${mf.id}: Invalid docking points. Skipping DI.`); continue; }
        plane.planeElement.push(moddle.create('bpmndi:BPMNEdge', { id: `${mf.id}_di`, bpmnElement: msgFlow, waypoint: [start, end].map(pt => moddle.create('dc:Point', pt)) }));
        console.log(`✅ Created DI edge for MF ${mf.id}`);
    } else { console.warn(`⚠️ MF ${mf.id}: Shapes not found (${mf.source}/${mf.target}). Cannot create DI edge.`); }
}


/* 8.5 ─── data association flows + DI edges (Repositioning Pass) ──────────────── */
const repositionedDataObjects = new Set();
// *** ADDED: Track max Y required by repositioned DOs per pool ***
const poolBottomRequirements = {}; // poolParticipantId -> maxY

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
    if (srcIsActivity && tgtIsDataObject) { activityBpmnElement = visualSourceBpmn; doBpmnElement = visualTargetBpmn; }
    else if (srcIsDataObject && tgtIsActivity) { activityBpmnElement = visualTargetBpmn; doBpmnElement = visualSourceBpmn; }
    else { console.warn(`⚠️ DA spec ${daSpec.id}: Cannot determine Activity/DO. Skip repo.`); continue; }
    if (!doBpmnElement || !activityBpmnElement) { console.warn(`⚠️ DA spec ${daSpec.id}: Failed ID DO/Activity. Skip repo.`); continue; }

    const doShape = shapeById[doBpmnElement.id];
    const activityShape = shapeById[activityBpmnElement.id];
    if (!doShape || !activityShape) { console.warn(`⚠️ DA spec ${daSpec.id}: Shapes not found for DO/Activity. Skip repo.`); continue; }
    if (!doShape.bounds || !activityShape.bounds) { console.warn(`⚠️ DA spec ${daSpec.id}: Missing bounds for DO/Activity. Skip repo.`); continue; }
    if (repositionedDataObjects.has(doBpmnElement.id)) continue;

    const actBounds = activityShape.bounds;
    const doBounds = doShape.bounds;
    const targetX = actBounds.x + (actBounds.width / 2) - (doBounds.width / 2) + DATA_OBJECT_H_GAP;
    const targetY = actBounds.y + actBounds.height + DATA_OBJECT_V_GAP;

    console.log(`✨ Planning reposition of ${doBpmnElement.id} below Activity ${activityBpmnElement.id}`);
    doShape.bounds.x = targetX;
    doShape.bounds.y = targetY;
    repositionedDataObjects.add(doBpmnElement.id);
    console.log(`-> Applied reposition for ${doBpmnElement.id}. New bounds: x=${targetX.toFixed(1)}, y=${targetY.toFixed(1)}`);

    // *** Track the bottom requirement for the pool ***
    const poolId = poolOfNode[activityBpmnElement.id]; // Get pool from the activity
    if (poolId) {
        const poolParticipantId = `Part_${poolId}`;
        const doBottomY = targetY + doBounds.height;
        const currentRequiredBottom = poolBottomRequirements[poolParticipantId] ?? -Infinity;
        poolBottomRequirements[poolParticipantId] = Math.max(currentRequiredBottom, doBottomY);
        console.log(` -> Pool ${poolParticipantId} requires bottom >= ${poolBottomRequirements[poolParticipantId].toFixed(1)} (due to ${doBpmnElement.id})`);
    }
}
console.log('--- Finished Repositioning ---');


/* 8.6 --- Adjust Pool Heights Based on Repositioned Data Objects --- */
console.log('\n--- Adjusting Pool Heights for Data Objects ---');
for (const [poolParticipantId, requiredBottomY] of Object.entries(poolBottomRequirements)) {
    const poolShape = poolShapeById[poolParticipantId]; // Use the map created in Section 7
    if (poolShape && poolShape.bounds) {
        const currentPoolBottom = poolShape.bounds.y + poolShape.bounds.height;
        const requiredPoolBottomWithPadding = requiredBottomY + POOL_INTERNAL_PADDING_OTHER;

        if (requiredPoolBottomWithPadding > currentPoolBottom) {
            const newHeight = requiredPoolBottomWithPadding - poolShape.bounds.y;
            console.log(`⬆️ Adjusting height for pool ${poolParticipantId}: ${poolShape.bounds.height.toFixed(1)} -> ${newHeight.toFixed(1)}`);
            poolShape.bounds.height = newHeight;
        } else {
            // console.log(` -> Pool ${poolParticipantId} height already sufficient.`); // Optional log
        }
    } else {
        console.warn(`⚠️ Could not find pool shape DI for ${poolParticipantId} to adjust height.`);
    }
}
console.log('--- Finished Adjusting Pool Heights ---');


/* 8.7 ─── Data Association Edge Creation Pass ──────────────── */
// *** Renumbered step for clarity ***
console.log('\n--- Creating Association Edges ---');
for (const daSpec of dataAssociationSpecs) {
    const actualAssocElement = byId[daSpec.id];
    const visualSourceBpmn = byId[daSpec.visualSourceId];
    const visualTargetBpmn = byId[daSpec.visualTargetId];
    if (!actualAssocElement) { console.warn(`⚠️ DA ${daSpec.id}: BPMN Assoc not found. Skip DI edge.`); continue; }
    if (!visualSourceBpmn || !visualTargetBpmn) { console.warn(`⚠️ DA ${daSpec.id}: Visual BPMN not found. Skip DI edge.`); continue; }
    const visualSourceShape = shapeById[visualSourceBpmn.id];
    const visualTargetShape = shapeById[visualTargetBpmn.id];
    if (visualSourceShape && visualTargetShape) {
        if (!visualSourceShape.bounds || !visualTargetShape.bounds) { console.warn(`⚠️ DA ${daSpec.id}: Missing bounds for docking. Skip DI edge.`); continue; }
        const start = dockPoint(visualSourceShape, visualTargetShape);
        const end   = dockPoint(visualTargetShape, visualSourceShape);
        if (isNaN(start.x) || isNaN(start.y) || isNaN(end.x) || isNaN(end.y)) { console.warn(`⚠️ DA ${daSpec.id}: Invalid docking points. Skip DI edge.`); continue; }
        plane.planeElement.push(moddle.create('bpmndi:BPMNEdge', { id: `${daSpec.id}_di`, bpmnElement: actualAssocElement, waypoint: [start, end].map(pt => moddle.create('dc:Point', pt)) }));
        console.log(`✅ Created DI edge for DA ${daSpec.id} (linked to ${actualAssocElement.$type})`);
    } else { console.warn(`⚠️ DA ${daSpec.id}: Shapes not found for visual src/tgt. Cannot create DI edge.`); }
}
console.log('--- Finished Creating Association Edges ---');


/* 9 ─── final serialisation + save ───────────────────────────── */
console.log('\nSerializing final BPMN XML...');
const { xml: finalXml } = await moddle.toXML(definitions, { format: true });
const outputPath = 'diagram.bpmn'; // Define output path
await fs.writeFile(outputPath, finalXml);
console.log(`✅ Layouted diagram saved to ${outputPath}`);