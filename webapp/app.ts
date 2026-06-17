import OpenSCAD from "./openscad/openscad.js";
const three = require('three')

const filename = "cube.stl";

// Instantiate the application
const instance = await OpenSCAD({noInitialRun: true});

// Write a file to the filesystem
instance.FS.writeFile("/input.scad", `cube(10);`); // OpenSCAD script to generate a 10mm cube

// Run like a command-line program with arguments
instance.callMain(["/input.scad", "--enable=manifold", "-o", filename]); // manifold is faster at rendering

// Read the output 3D-model into a JS byte-array
const output = instance.FS.readFile("/"+filename);

// Generate a link to output 3D-model and download the output STL file
const link = document.createElement("a");
link.href = URL.createObjectURL(
new Blob([output], { type: "application/octet-stream" }), null);
link.download = filename;
document.body.append(link);


const loader = new STLLoader();
