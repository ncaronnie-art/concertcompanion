/** Convert tagged HDR to SDR before analysis, previews and creative finishing.
 * This is display conversion, not recovered detail or generated image content. */
export function hdrToSdrFilter(transfer?: string): string {
  return transfer === "arib-std-b67" || transfer === "smpte2084" ?
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p," : "";
}
