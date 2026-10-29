import {
  createContext,
  useContext,
  useId,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode
} from "react";

type MaterialMode = "frosted" | "refracted" | "solid";
const MaterialContext = createContext<{ mode: MaterialMode; setMode: (mode: MaterialMode) => void }>({
  mode: "frosted",
  setMode: () => {}
});

/** 材质偏好只保存在内存，默认不启用开销更高且兼容性有限的 SVG 折射 */
export function MaterialProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<MaterialMode>("frosted");
  return (
    <MaterialContext value={{ mode, setMode }}>
      <div data-material={mode}>{children}</div>
    </MaterialContext>
  );
}

/** 三层容器共用同一边界，嵌套时强制回退为实体表面以避免叠加模糊 */
export function Surface({
  material = "standard",
  className = "",
  children,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { material?: "standard" | "frosted" | "liquid" }) {
  const { mode } = useContext(MaterialContext);
  const id = `refraction-${useId().replaceAll(":", "")}`;
  const refracted = material === "liquid" && mode === "refracted";
  return (
    <div
      {...props}
      className={`surface surface-${material} ${className}`}
      style={
        {
          ...style,
          ...(refracted ? { "--refraction-filter": `url(#${id}) blur(2px)` } : {})
        } as CSSProperties
      }
      data-refraction={refracted || undefined}
    >
      {refracted && (
        <svg className="material-filter" aria-hidden="true" focusable="false">
          <defs>
            <filter id={id} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
              <feTurbulence type="fractalNoise" baseFrequency="0.012 0.025" numOctaves="1" seed="8" result="noise" />
              <feDisplacementMap in="SourceGraphic" in2="noise" scale="6" xChannelSelector="R" yChannelSelector="G" />
            </filter>
          </defs>
        </svg>
      )}
      {children}
    </div>
  );
}

/** 原生 Popover 支持 Escape、外部点击及焦点返回，选择实体可关闭透明效果 */
export function MaterialSettings() {
  const { mode, setMode } = useContext(MaterialContext);
  const id = useId();
  return (
    <>
      <button popoverTarget={id} className="material-trigger" aria-label="外观设置">
        外观
      </button>
      <div id={id} popover="auto" className="material-popover">
        <Surface material="frosted">
          <h3>外观</h3>
          <label>
            浮层材质
            <select value={mode} onChange={(event) => setMode(event.target.value as MaterialMode)}>
              <option value="frosted">轻透玻璃</option>
              <option value="refracted">液态折射 · 实验</option>
              <option value="solid">实体 · 低开销</option>
            </select>
          </label>
        </Surface>
      </div>
    </>
  );
}
