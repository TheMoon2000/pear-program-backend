import { randomInt } from "crypto"

/** Records the proportion of characters written by both users on a particular line. */
interface LineContribution {
    lineNumber: number
    user1: number // between 0-1
    user2: number // between 0-1
}

/** Given who the explainer is, pick a range of code written by the other person. */
export function intersubjectivity(code: string, authorMap: string, explainer: 0 | 1): { startIndex: number, endIndex: number } | null {
    if (code.length !== authorMap.length) {
        console.warn("Code and author map don't match", code.length, authorMap.length)
        return null
    }

    let nonemptyLines: LineContribution[] = []

    // Skip all lines of code that contain entirely of space characters
    const authorMapByLine = authorMap.split("\n")
    const codeByLine = code.split("\n")
    for (let i = 0; i < codeByLine.length; i++) {
        if ((codeByLine[i].match(/\S/g) ?? []).length > 0) {
            nonemptyLines.push({
                lineNumber: i,
                user1: (authorMapByLine[i].match(/0/g) ?? []).length / authorMapByLine[i].length,
                user2: (authorMapByLine[i].match(/1/g) ?? []).length / authorMapByLine[i].length
            })
        }
    }

    console.log('nonempty lines', nonemptyLines)

    // Find all consecutive chunks (≥ 2 lines) written by the verifier
    let chunks: {startIndex: number, endIndex: number}[] = []

    let chunkStart: number | undefined
    for (let i = 0; i < nonemptyLines.length; i++) {
        const line = nonemptyLines[i]
        const verifierContribution = explainer === 0 ? line.user2 : line.user1
        if (verifierContribution >= 0.7) {
            if (chunkStart === undefined) {
                chunkStart = i
            }
        } else {
            if (chunkStart !== undefined && i - chunkStart >= 2) {
                chunks.push({ startIndex: chunkStart, endIndex: i - 1 })
            }
            chunkStart = undefined
        }
    }
    if (chunkStart !== undefined) {
        chunks.push({ startIndex: chunkStart, endIndex: nonemptyLines.length - 1 })
    }

    console.log("chunks", chunks)

    if (chunks.length === 0) { return null }
    
    return chunks[randomInt(chunks.length)]
}

const exampleCode = `def main():
    """
    You should write your code here. Make sure to delete 
    the 'pass' line before starting to write your own code.
    """
    print("user1")
    print("user1")
    print("user2")
    print("user2")

if __name__ == '__main__':
    main()`

const exampleAuthorMap = `???????????
???????
?????????????????????????????????????????????????????????
???????????????????????????????????????????????????????????
???????
????00000000000000
????00000000000000
????11111111111111
????11111111111111

??????????????????????????
??????????`

// console.log(intersubjectivity(exampleCode, exampleAuthorMap, 1))