import OpenSCAD from "./openscad-wasm/build/openscad.wasm.js";

let instancePromise: Promise<any> | null = null;

self.onmessage = async (e: MessageEvent) => {
    const msg = e.data;
    try {
        if (msg.type === "render") {
            if (!instancePromise) {
                instancePromise = OpenSCAD({
                    noInitialRun: true,
                    noExitRuntime: true,
                    locateFile: (path: string) =>
                        new URL(`./${path}`, import.meta.url).href,
                });
            }
            const inst = await instancePromise;
            inst.FS.writeFile("./input.scad", msg.source);
            const filename = `v_${msg.name}_${msg.index}.stl`;
            inst.callMain([
                "./input.scad",
                ...msg.cliArgs,
                "-o",
                filename,
            ]);
            const out = inst.FS.readFile(`./${filename}`, { encoding: "binary" });
            const buffer = out.slice().buffer;
            (self as unknown as Worker).postMessage(
                { type: "rendered", index: msg.index, buffer },
                [buffer],
            );
        }
    } catch (err: any) {
        (self as unknown as Worker).postMessage({
            type: "error",
            index: msg.index,
            message: String(err?.message ?? err),
        });
    }
};
