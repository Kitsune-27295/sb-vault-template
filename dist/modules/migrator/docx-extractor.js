import { inflateRawSync } from "node:zlib";
export function extractDocumentXmlFromZip(buffer) {
    let offset = 0;
    const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
    while (offset < buffer.length - 30) {
        const signature = buffer.readUInt32LE(offset);
        if (signature !== LOCAL_FILE_HEADER_SIGNATURE) {
            // Look for next signature
            offset++;
            continue;
        }
        const compressionMethod = buffer.readUInt16LE(offset + 8);
        const compressedSize = buffer.readUInt32LE(offset + 18);
        const fileNameLength = buffer.readUInt16LE(offset + 26);
        const extraFieldLength = buffer.readUInt16LE(offset + 28);
        const fileNameStart = offset + 30;
        const fileNameEnd = fileNameStart + fileNameLength;
        if (fileNameEnd > buffer.length)
            break;
        const fileName = buffer.toString("utf8", fileNameStart, fileNameEnd);
        const dataStart = fileNameEnd + extraFieldLength;
        const dataEnd = dataStart + compressedSize;
        if (dataEnd > buffer.length)
            break;
        if (fileName === "word/document.xml") {
            const compressedData = buffer.subarray(dataStart, dataEnd);
            if (compressionMethod === 8) {
                return inflateRawSync(compressedData).toString("utf8");
            }
            else if (compressionMethod === 0) {
                return compressedData.toString("utf8");
            }
        }
        offset = dataEnd;
    }
    return null;
}
export function convertXmlToMarkdown(xml) {
    const paragraphs = [];
    // Match paragraph elements <w:p ...>...</w:p>
    const paragraphRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
    let pMatch;
    while ((pMatch = paragraphRegex.exec(xml)) !== null) {
        const pContent = pMatch[1];
        // Check heading style
        let headingPrefix = "";
        if (pContent.includes('w:val="Heading1"') || pContent.includes('w:val="1"')) {
            headingPrefix = "# ";
        }
        else if (pContent.includes('w:val="Heading2"') || pContent.includes('w:val="2"')) {
            headingPrefix = "## ";
        }
        else if (pContent.includes('w:val="Heading3"') || pContent.includes('w:val="3"')) {
            headingPrefix = "### ";
        }
        // Match text fragments <w:t ...>text</w:t>
        const textRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
        let tMatch;
        let lineText = "";
        while ((tMatch = textRegex.exec(pContent)) !== null) {
            lineText += tMatch[1];
        }
        lineText = lineText.trim();
        if (lineText) {
            paragraphs.push(headingPrefix + lineText);
        }
    }
    const rawText = paragraphs.join("\n\n");
    const markdown = convertAsciiTreesToMermaid(rawText);
    return {
        text: rawText,
        markdown,
        paragraphs
    };
}
export function convertAsciiTreesToMermaid(text) {
    // Detect ASCII tree diagrams with ├──, └──, │ or +- --
    const asciiTreeRegex = /(?:^[ \t]*(?:[│|├└+`-][─\-\s│|├└+`]+[^\r\n]+)\r?\n?){2,}/gm;
    return text.replace(asciiTreeRegex, (treeBlock) => {
        const lines = treeBlock.split(/\r?\n/).filter((l) => l.trim().length > 0);
        const mermaidLines = ["```mermaid", "graph TD"];
        const parentStack = [];
        let nodeIndex = 1;
        for (const line of lines) {
            // Determine depth based on indentation and tree branch markers
            const depth = line.search(/[\w\d.-]/);
            const label = line.replace(/^[ \t│|├└+`─\-]+/, "").trim();
            if (!label)
                continue;
            const currentId = `N${nodeIndex++}`;
            const escapedLabel = `"${label.replace(/"/g, "'")}"`;
            while (parentStack.length > 0 && parentStack[parentStack.length - 1].depth >= depth) {
                parentStack.pop();
            }
            if (parentStack.length > 0) {
                const parent = parentStack[parentStack.length - 1];
                mermaidLines.push(`  ${parent.id} --> ${currentId}[${escapedLabel}]`);
            }
            else {
                mermaidLines.push(`  ${currentId}[${escapedLabel}]`);
            }
            parentStack.push({ depth, id: currentId });
        }
        mermaidLines.push("```");
        return "\n" + mermaidLines.join("\n") + "\n";
    });
}
//# sourceMappingURL=docx-extractor.js.map