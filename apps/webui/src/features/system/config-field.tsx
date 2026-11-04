import { useEffect, useId, useState } from "react";
import type { ConfigFieldSchema, ConfigFileChange } from "@synapse/runtime-client";
import { configLabel, configVariant, initialConfigValue, objectValue } from "./settings-model.js";

type FieldProps = {
  schema: ConfigFieldSchema;
  value: unknown;
  path: readonly string[];
  onChange: (change: ConfigFileChange) => void;
  required?: boolean;
  expanded?: boolean;
};

/** 根据领域规则选择控件，复杂配置逐字段编辑而不要求用户编写完整 JSON */
export function ConfigField({ schema: input, value, path, onChange, required = false, expanded = false }: FieldProps) {
  const id = useId();
  const schema = configVariant(input, value);
  const name = path.at(-1) ?? "";
  const title = path.join(".") === "locale.default" ? "默认语言" : configLabel(name);
  const variants = input.anyOf ?? input.oneOf;
  const choices = variants?.map((variant) =>
    Object.entries(variant.properties ?? {}).find(([, field]) => field.const !== undefined)
  );
  const set = (next: unknown) => onChange({ path, value: next });
  const masked = value === "[REDACTED]";
  const secret =
    masked ||
    /secret|password|apikey|accessToken|^token$|authorization/i.test(name) ||
    path.some((part) => ["headers", "env", "extraBody"].includes(part));
  const effective = value === undefined ? schema.default : value;
  const object = schema.type === "object" || schema.properties !== undefined;
  const array = schema.type === "array";
  const removable = value !== undefined && !required;
  const reset = removable && (
    <button
      type="button"
      className="text-button"
      title="从文件移除此项，恢复默认或继承值"
      onClick={() => onChange({ path, remove: true })}
    >
      移除
    </button>
  );

  if (object || array) {
    if (value === undefined && !expanded)
      return (
        <div className="config-optional">
          <div>
            <strong>{title}</strong>
            <small>{path.join(".")}</small>
          </div>
          <button type="button" onClick={() => set(initialConfigValue(input))}>
            配置{title}
          </button>
        </div>
      );
    const values = objectValue(value);
    const defaults = objectValue(schema.default);
    const properties = schema.properties ?? {};
    const dynamicSchema = typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined;
    const content = (
      <>
        {choices?.every(Boolean) && choices.length > 1 && (
          <label className="config-variant">
            配置类型
            <select
              aria-label={`${path.join(".")} 配置类型`}
              value={String(
                Object.values(schema.properties ?? {}).find((field) => field.const !== undefined)?.const ?? ""
              )}
              onChange={(event) => {
                const variant = variants!.find((item) =>
                  Object.values(item.properties ?? {}).some((field) => field.const === event.target.value)
                );
                if (variant) set(initialConfigValue(variant));
              }}
            >
              {choices.map((entry) => (
                <option key={String(entry![1].const)} value={String(entry![1].const)}>
                  {String(entry![1].const)}
                </option>
              ))}
            </select>
          </label>
        )}
        {object ? (
          <>
            {Object.entries(properties)
              .filter(([, field]) => field.const === undefined)
              .map(([key, field]) => (
                <ConfigField
                  key={key}
                  schema={field}
                  value={values[key]}
                  path={[...path, key]}
                  onChange={onChange}
                  required={schema.required?.includes(key) ?? false}
                />
              ))}
            {[...new Set([...Object.keys(defaults), ...Object.keys(values)])]
              .filter((key) => !Object.hasOwn(properties, key))
              .map((key) => (
                <ConfigField
                  key={key}
                  schema={{
                    ...(dynamicSchema ?? inferSchema(values[key] ?? defaults[key])),
                    ...(Object.hasOwn(defaults, key) ? { default: defaults[key] } : {})
                  }}
                  value={values[key]}
                  path={[...path, key]}
                  onChange={onChange}
                />
              ))}
            {(dynamicSchema || schema.additionalProperties === true) && (
              <AddConfigEntry
                schema={dynamicSchema ?? { type: "string" }}
                names={Object.keys(values)}
                path={path}
                nameSchema={schema.propertyNames}
                onChange={onChange}
              />
            )}
          </>
        ) : (
          <>
            {(Array.isArray(effective) ? effective : []).map((item, index) => (
              <div className="config-array-item" key={index}>
                <ConfigField
                  schema={schema.items ?? inferSchema(item)}
                  value={item}
                  path={[...path, String(index)]}
                  onChange={onChange}
                  required
                />
                <button
                  type="button"
                  aria-label={`删除 ${path.join(".")} 第 ${index + 1} 项`}
                  onClick={() => onChange({ path: [...path, String(index)], remove: true })}
                >
                  删除
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => {
                if (value === undefined) set([initialConfigValue(schema.items ?? {})]);
                else
                  onChange({
                    path: [...path, String((value as unknown[]).length)],
                    value: initialConfigValue(schema.items ?? {})
                  });
              }}
            >
              添加一项
            </button>
          </>
        )}
      </>
    );
    return expanded ? (
      <div className="config-fields">{content}</div>
    ) : (
      <div className="config-group-wrap">
        <details className="config-group" open>
          <summary>
            {title}
            <small>{path.join(".")}</small>
          </summary>
          <div className="config-fields">{content}</div>
        </details>
        {reset}
      </div>
    );
  }

  const options = schema.enum ?? (schema.const === undefined ? undefined : [schema.const]);
  const numeric = schema.type === "number" || schema.type === "integer";
  const boolean = schema.type === "boolean";
  const defaultHint = schema.default === undefined ? "未配置，使用继承值" : `默认：${String(schema.default)}`;
  return (
    <div className="config-field">
      <div className="config-field-heading">
        <label htmlFor={id}>
          {title}
          {required && <span className="muted"> *</span>}
        </label>
        {reset}
      </div>
      <small className="config-key">{path.join(".")}</small>
      {boolean ? (
        <label className="config-switch" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            role="switch"
            checked={effective === true}
            onChange={(event) => set(event.target.checked)}
          />
          <span>{effective === true ? "已启用" : "已停用"}</span>
        </label>
      ) : options ? (
        <select
          id={id}
          value={effective === undefined ? "" : String(effective)}
          onChange={(event) => set(options.find((option) => String(option) === event.target.value))}
          required={required}
        >
          <option value="" disabled>
            请选择
          </option>
          {options.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      ) : schema.type === undefined && value !== undefined && typeof value !== "string" ? (
        <JsonConfigValue id={id} value={value} onChange={set} />
      ) : numeric ? (
        <NumericConfigValue
          id={id}
          value={effective}
          schema={schema}
          required={required || value !== undefined}
          onChange={set}
        />
      ) : (
        <input
          id={id}
          type={secret ? "password" : "text"}
          autoComplete={secret ? "new-password" : "off"}
          value={masked ? "" : effective === undefined ? "" : String(effective)}
          placeholder={masked ? "已配置，输入新值以替换" : defaultHint}
          minLength={secret ? undefined : schema.minLength}
          maxLength={schema.maxLength}
          required={required && !masked && schema.default === undefined}
          onChange={(event) => {
            if (masked && event.target.value === "") return;
            set(event.target.value);
          }}
        />
      )}
      {value === undefined && <small className="muted">{defaultHint}</small>}
      {numeric && (
        <small className="muted">
          {schema.minimum !== undefined
            ? `最小 ${schema.minimum}`
            : schema.exclusiveMinimum !== undefined
              ? `大于 ${schema.exclusiveMinimum}`
              : ""}
          {schema.maximum !== undefined ? ` · 最大 ${schema.maximum}` : ""}
        </small>
      )}
    </div>
  );
}

function NumericConfigValue({
  id,
  value,
  schema,
  required,
  onChange
}: {
  id: string;
  value: unknown;
  schema: ConfigFieldSchema;
  required: boolean;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => {
    setText(value === undefined ? "" : String(value));
  }, [value]);
  return (
    <input
      id={id}
      type="number"
      value={text}
      required={required}
      min={
        schema.minimum ??
        (schema.exclusiveMinimum === undefined
          ? undefined
          : schema.exclusiveMinimum + (schema.type === "integer" ? 1 : Number.EPSILON))
      }
      max={schema.maximum}
      step={schema.type === "integer" ? 1 : "any"}
      onChange={(event) => {
        setText(event.target.value);
        if (event.target.value !== "" && Number.isFinite(event.target.valueAsNumber))
          onChange(event.target.valueAsNumber);
      }}
    />
  );
}

function AddConfigEntry({
  schema,
  names,
  path,
  nameSchema,
  onChange
}: {
  schema: ConfigFieldSchema;
  names: readonly string[];
  path: readonly string[];
  nameSchema: ConfigFieldSchema | undefined;
  onChange: (change: ConfigFileChange) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="config-add-entry">
      <label>
        新条目标识
        <input
          value={name}
          placeholder={path[0] === "permissions" ? "例如 network.web.fetch" : "例如 my-provider"}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
        />
      </label>
      <button
        type="button"
        disabled={!name.trim()}
        onClick={() => {
          const key = name.trim();
          if (
            ["__proto__", "prototype", "constructor"].includes(key) ||
            names.includes(key) ||
            (nameSchema?.pattern && !new RegExp(nameSchema.pattern).test(key))
          ) {
            setError("标识格式不正确或已存在");
            return;
          }
          onChange({ path: [...path, key], value: initialConfigValue(schema) });
          setName("");
          setError("");
        }}
      >
        添加
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

function inferSchema(value: unknown): ConfigFieldSchema {
  if (Array.isArray(value)) return { type: "array" };
  if (value !== null && typeof value === "object") return { type: "object", additionalProperties: true };
  return { type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string" };
}

function JsonConfigValue({ id, value, onChange }: { id: string; value: unknown; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  return (
    <textarea
      id={id}
      rows={4}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        try {
          const next: unknown = JSON.parse(event.target.value);
          event.target.setCustomValidity("");
          onChange(next);
        } catch {
          event.target.setCustomValidity("请输入有效的 JSON 值");
        }
      }}
    />
  );
}
