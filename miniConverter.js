/* minimal‑converter.js
   --------------------
   npm i bpmn-moddle        # only dependency
   (package.json may stay plain CommonJS; no ESM tricks needed)
*/

import BpmnModdle from 'bpmn-moddle';
import fs         from 'node:fs/promises';

const moddle = new BpmnModdle();

/* 1 ─── core BPMN elements ───────────────────────────────────── */
const task = moddle.create('bpmn:Task', {
  id:   'Task_1',
  name: 'Do work'
});

const dataObject = moddle.create('bpmn:DataObject', { id: 'Doc_1_Obj' });

const dataObjectRef = moddle.create('bpmn:DataObjectReference', {
  id:        'Doc_1',
  name:      'Report',
  dataObject // <‑‑ ties the reference to the actual data object
});

/* DataOutputAssociation: sourceRef = ARRAY, targetRef = SINGLE */
const assoc = moddle.create('bpmn:DataOutputAssociation', {
  id:        'Assoc_1',
  sourceRef: [task],
  targetRef: dataObjectRef
});

/* 2 ─── assemble the process ─────────────────────────────────── */
const processEl = moddle.create('bpmn:Process', {
  id:           'Process_1',
  isExecutable: true,
  flowElements: [ task, dataObjectRef, dataObject, assoc ]
});

/* 3 ─── definitions shell ────────────────────────────────────── */
const definitions = moddle.create('bpmn:Definitions', {
  id:              'Defs_1',
  targetNamespace: 'http://example.com/bpmn',
  rootElements:    [ processEl ]
});

/* 4 ─── very small amount of DI (shapes + one edge) ──────────── */
const diagram = moddle.create('bpmndi:BPMNDiagram', { id: 'Diagram_1' });
const plane   = moddle.create('bpmndi:BPMNPlane',  { id: 'Plane_1', bpmnElement: processEl });

diagram.set('plane', plane);
definitions.get('diagrams').push(diagram);

/* Task: 100×80 at (100,100) */
plane.get('planeElement').push(
  moddle.create('bpmndi:BPMNShape', {
    id:          'Task_1_di',
    bpmnElement: task,
    bounds:      moddle.create('dc:Bounds', { x: 100, y: 100, width: 100, height: 80 })
  })
);

/* DataObject: 36×50 at (350,105) (rough default size Camunda uses) */
plane.get('planeElement').push(
  moddle.create('bpmndi:BPMNShape', {
    id:          'Doc_1_di',
    bpmnElement: dataObjectRef,
    bounds:      moddle.create('dc:Bounds', { x: 350, y: 105, width: 36, height: 50 })
  })
);

/* Dotted edge: from task’s right centre to data‑object’s left centre */
plane.get('planeElement').push(
  moddle.create('bpmndi:BPMNEdge', {
    id:          'Assoc_1_di',
    bpmnElement: assoc,
    waypoint: [
      moddle.create('dc:Point', { x: 200, y: 140 }), // task centre‑right
      moddle.create('dc:Point', { x: 350, y: 130 })  // data‑object centre‑left
    ]
  })
);

/* 5 ─── serialise and save ───────────────────────────────────── */
const { xml } = await moddle.toXML(definitions, { format: true });
await fs.writeFile('diagram.bpmn', xml);
console.log('✅  task_dataobject.bpmn written – open it in Camunda Modeler');
