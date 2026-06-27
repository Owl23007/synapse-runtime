export function textMessage(text, id) {
    return {
        ...(id === undefined ? {} : { id }),
        type: "text",
        segments: [{ type: "text", text }]
    };
}
export function getTextContent(message) {
    return message.segments
        .filter((segment) => segment.type === "text")
        .map((segment) => segment.text)
        .join("");
}
//# sourceMappingURL=index.js.map