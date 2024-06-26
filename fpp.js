// Javascript PDP 11/70 Emulator v3.1
// written by Paul Nankervis
// Please send suggestions, fixes and feedback to paulnank@hotmail.com
//
// This code may be used freely provided the original author name is acknowledged in any modified source code
//
//
// Note: PDF listings of PDP 11 FPP diagnistics can be found at:
//          http://bitsavers.org/pdf/dec/pdp11/microfiche/ftp.j-hoppe.de/bw/gh/
//
//
//
// This is the second version of FPP emulation for the above Javascript emulator. When the
// emulator encounters a FPP instruction it simply calls the function executeFPP() contained
// below. The main emulator routines have no other knowledge of FPP functions except that the
// function getVirtualByMode() is able to handle operand lengths of 4 (real) and 8 (double),
// in addition to the usual 1 (byte) and 2 (word) byte operands, and that CPU.trapMask can
// cause a floating point exception when needed.
//
// The first version of these routines simply converted PDP 11 floating point values into
// Javascript numbers, and all PDP 11 operations were performed using native Javascript.
// This was very fast, but unfortunately Javascript numbers have slightly less precision
// than PDP 11 double length (although with a larger range). This made it impossible to pass
// the full range of PDP 11 diagnostics which resulted in low confidence they were correct.
// This version stores all floating point values as an array of up to four 16 bits words.
// It matches very closely with PDP 11 storage, however it involves a lot of Javascript
// code which does rather obscure bit manipulation (cross word bit shifts rule!).
//
// Standard PDP 11 floating point data formats used by FPP instructions are:-
// Integer formats:-
//  2 byte: (usual PDP 11 word containing bits 15 - 0) 16 bits with signing via 2's complement
//  4 byte: Word 1 High half (bits 31 - 16), Word 2 Low half (bits 15 - 0) 32 bits with signing by 2's complement
// Real formats:- (sign bit always first followed by 8 bits of exponent - which has a bias of +128)
//  2 byte: Immediate mode   Sign (1 bit 15) Exponent (8 bits 14 - 7)  Fraction (7 bits 6 - 0) + hidden bit
//  4 byte: Single precision Sign (1 bit 31) Exponent (8 bits 30 - 23) Fraction (23 bits 22 - 0) + hidden bit
//  8 byte: Double precision Sign (1 bit 63) Exponent (8 bits 62 - 55) Fraction (55 bits 54 - 0) + hidden bit
//
// Zero = sign=0 & exponent=0 (exact zero is all zero's but any number with an exponent of zero is treated as zero)
// NaN  = sign=1 & exponent=0 (undefined variable usually traps on read from memory but generally treated as zero)
//
// In this code double floating point PDP 11 numbers are stored as an array of four 16 bit
// Javascript numbers. Real numbers (the short form) are kept in an array of two 16 bit numbers.
// In both cases array element 0 contains the sign, then 8 bits of the exponent (biased by +128),
// then the first 7 bits of the fraction, including an assumed hidden bit. The remaining array
// elements contain any additional fraction bits.
//
// In Javascript the exact zero PDP 11 double FPP number would be represented by [0, 0, 0, 0]
// Similarly 1 is represented as [16512,0,0,0], -7 as [49632,0,0,0] and 3.14159 as [16713,4047,32988,13168]
//
// Addresses of floating point numbers are stored as virtual addresses (17 bit I/D), unlike
// words and bytes in the main emulator modules which use 22 bit physical addresses.
// This is because floating point numbers may be up to eight bytes in length and cross virtual
// memory page boundaries which means they may not be contiguous in physical memory.
// The extra length also means floating point autoincrement and autodecrement addressing may increment
// and decrement registers by 8, 4 or 2 bytes. Note also that immediate mode {(R7)+ and -(R7)} always
// assume an operand length of two bytes - the PC is incremented by 2 regardless of data type, probably
// for easier coupling with the asyncronous FPP co-processor where the CPU doesn't have to know FPP
// data types or current FPP precision (OK, I can't really justify it - maybe it really is just to
// provide short literal FPP numbers to conserve program memory?).
//
//
// The FPP processor has its own registers:-
//      FPS containing  various mode, status and condition code bits
//      FEC containing an error code
//      FEA which records the PC for error conditions
//   and six accumulators for FPP numbers (FPP registers)
//
//
// FPS bits:-
//  15: FER - floating point error
//  14: FID - floating interrupt disable
//  13: Not Used
//  12: Not Used
//  11: FIUV - Floating interrupt on undefined variable
//  10: FIU - Floating interrupt on underflow
//   9: FIV - Floating interrupt on overflow
//   8: FIC - Floating interrupt on integer conversion
//   7: FD - Double precision mode
//   6: FL - Long integer mode
//   5: FT - Truncate (not round)
//   4: Not Used
//   3: FN - CC Negative
//   2: FZ - CC Zero
//   1: FV - CC Overflow
//   0: FC - CC Carry
//
// FEC values:-
//  2 Floating OP code error
//  4 Floating divide by zero
//  6 Floating (or double) to integer conversion error
//  8 Floating overflow
//  10 Floating underflow
//  12 Floating undefined variable
//  14 Maintenance trap
//
//
// The FPP design assures that the undefined variable (-0) will not be stored
// as the result of any floating point operation in a program run with the
// overflow and underflow interrupts disabled. This is achieved by storing an
// exact zero on overflow or underflow, if the corresponding
// interrupt is disabled. This feature, together with an ability to detect a
// reference to the undefined variable, is intended to provide the user
// with a debugging aid. If a -0 is generated, it is not a result of a
// previous floating point arithmetic instruction.
//
// An interrupt occurs if FIUV is set and a -0 is obtained from memory as
// an operand of ADD, SUB, MUL, DIV, CMP, MOD, NEG, ABS, TST, or
// any LOAD instruction. The interrupt occurs before execution except
// on NEG and ABS instructions. For these instructions, the interrupt
// occurs after execution. When FIUV is reset, -0 can be loaded and
// used in any FPP operation. Note that the interrupt is not activated by
// the presence of -0 in an AC operand of an arithmetic instruction. In
// particular, trap on -0 never occurs in mode 0 (register mode).
//
// The floating point processor recognizes seven floating point
// exceptions:
// • detection of the presence of the undefined variable in memory
// • floating overflow
// • floating underflow
// • failure of floating to integer conversion
// • maintenance trap
// • attempt to divide by zero
// • illegal floating OP code
// For the first five of these exceptions, bits in the FPS register are available
// to enable or disable interrupts individually. An interrupt on the
// occurrence of either of the last two exceptions can be disabled only by
// setting a bit which disables interrupts on all seven of the exceptions as
// a group.
//
// Diagnostics are KFPA, KFPB and KFPC
//
"use strict";

const
    FPPsignMask = 0x8000, // sign bit mask
    FPPexpBias = 0x80, // exponent bias
    FPPexpMask = 0x7f80, // exponent mask
    FPPexpShift = 7, // exponent shift to bit 0
    FPPhiddenMask = 0x0080, // hidden bit mask (or value)
    FPPfractionMask = 0x007f, // fraction mask
    FPPwordCount = 4, // number of 16 bit words in FPP value.
    FPPwordBase = 0x10000, // Word base
    FPPwordMask = 0xffff, // Word bit mask
    FPPwordBits = 16; // Bit shift between words

var FPP = {
    backupPC: 0, // PC of current instruction
    FEA: 0, // FPP error PC
    FEC: 0, // FPP error code
    FPS: 0, // FPP status/error bits
    modeLength: 0, // length in words of the current instruction operand (1 for immediate, 2 for real, 4 for double)
    precisionLength: FPPwordCount, // length in words of current FPP data type (2 for real, 4 for double)
    result: [0, 0, 0, 0, 0, 0, 0], // Work area for multiply/divide
    scratch: [0, 0, 0, 0], // Work area for general instructions
    AC: [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0]
    ] // The six FPP accumulators AC[0]... AC[5]
};

// Adds PC word to current debug log entry - eg the x in 'LDF ac2,#x'
function FPP_OPERAND(pcWord) {
    "use strict";
    if (log.limit) {
        log.ring[log.ring.length - 1].push(pcWord);
    }
}

// Add an intruction log debug entry
function FPP_INSTRUCTION(instruction, name, format) {
    "use strict";
    if (log.limit) { // Only do debug stuff if there is a log limit
        log.ring.push([FPP.FPS, CPU.registerVal[7], instruction, name, format]);
        while (log.ring.length > log.limit) {
            log.ring.shift();
        }
        if (CPU.registerVal[7] - 2 == log.debugPC) { // Set browser breakpoint here to stop at debug PC
            console.log(FPP.FPS.toString(8) + " " + CPU.registerVal[7].toString(8) + " " + instruction.toString(8) + " " + name);
        }
    }
}

function incrementVirtual(virtualAddress) {
    "use strict";
    return (virtualAddress & 0x10000) | ((virtualAddress + 2) & 0xffff);
}

function fppFlags() { // 8 - N,  4 - Z,  2 - V,  1 - C Copy FPP flags to CPU flags
    "use strict";
    setFlags(0xf, FPP.FPS); // Set CPU flags based on FPS flags
}

function fppZero(number) { // Zero a FPP number
    "use strict";
    var i;
    for (i = FPP.precisionLength - 1; i >= 0; i--) {
        number[i] = 0;
    }
}

function fppCopy(number, operand) { // Copy a FPP number
    "use strict";
    var i;
    for (i = FPP.precisionLength - 1; i >= 0; i--) {
        number[i] = operand[i];
    }
}

function fppTest(number) { // Test a FPP number (only Z or N can be set)
    "use strict";
    FPP.FPS &= 0xfff0; //   8 - N,  4 - Z,  2 - V,  1 - C
    if (!(number[0] & FPPexpMask)) {
        FPP.FPS |= 4; // Z bit
    }
    if (number[0] & FPPsignMask) {
        FPP.FPS |= 8; // N Bit
    }
}

function fppTestInt(operand) { // Test an integer operand (only Z or N can be set)
    "use strict";
    FPP.FPS &= 0xfff0; //   8 - N,  4 - Z,  2 - V,  1 - C
    if (operand < 0) FPP.FPS |= 8; // N Bit
    if (operand == 0) FPP.FPS |= 4; // Z bit
}

function fppTrap(code) { // Trap code called by individual trap functions
    "use strict";
    FPP.FPS |= 0x8000; // Set FER - floating point error
    FPP.FEC = code;
    FPP.FEA = (FPP.backupPC - 2) & 0xffff;
    if (!(FPP.FPS & 0x4000)) { // Check FID - floating interrupt disable
        CPU.trapMask |= 8; // Tell main emulator to FPP trap
    }
    return -1;
}

function fppPack(number, numberExp, numberSign) { // Routine to pack sign and pre-biased exponent back into a number
    "use strict";
    var condition = 0; //   8 - N,  4 - Z,  2 - V,  1 - C
    if (numberExp <= 0) {
        numberExp &= 0xff;
        if (FPP.FPS & 0x400) { // FIU - Floating interrupt on underflow
            fppTrap(10); // 10 Floating underflow
            if (!numberExp) condition |= 4; // Z bit
        } else {
            fppZero(number);
            numberSign = 0;
            numberExp = 0;
            condition |= 4; // Z bit
        }
    } else {
        if (numberExp >= 0x100) {
            numberExp &= 0xff; //0200;
            if (FPP.FPS & 0x200) { // FIV - Floating interrupt on overflow
                fppTrap(8); // 8 Floating overflow
                if (!numberExp) condition |= 4; // Z bit
            } else {
                fppZero(number);
                numberSign = 0;
                numberExp = 0;
                condition |= 4; // Z bit
            }
            condition |= 2; // V bit
        }
    }
    number[0] = numberSign | (numberExp << FPPexpShift) | (number[0] & FPPfractionMask);
    if (numberSign) {
        condition |= 8; // N bit
    }
    FPP.FPS = (FPP.FPS & 0xfff0) | condition;
}

function fppLDEXP(number, numberExp) { // Routine to load a new exponent into a FPP number
    "use strict";
    var numberSign;
    numberSign = number[0] & FPPsignMask;
    number[0] = (number[0] & FPPfractionMask) | FPPhiddenMask;
    if (numberExp & 0x8000) {
        numberExp = numberExp - 0x10000;
    }
    numberExp += FPPexpBias;
    fppPack(number, numberExp, numberSign);
}

function fppCompare(src1, src2) { // Compare floating point numbers: 0 if =, -ve if src1 < src2, +ve if src1 > src2
    "use strict";
    var i, result = 0;
    FPP.FPS &= 0xfff0;
    if ((src1[0] | src2[0]) & FPPexpMask) { // If both exponents zero then finished!
        if ((src1[0] ^ src2[0]) & FPPsignMask) { // For different signs + is larger
            result = 1;
        } else { // For same sign and both not zero then need to compare fractions
            result = (src1[0] & ~FPPsignMask) - (src2[0] & ~FPPsignMask); // Difference exponent and initial fraction
            if (!result) { // If zero compare rest
                for (i = 1; i < FPP.precisionLength; i++) {
                    result = src1[i] - src2[i];
                    if (result) {
                        break;
                    }
                }
            }
        }
    }
    if (!result) {
        FPP.FPS |= 4; // Zero flag
    } else {
        if (src1[0] & FPPsignMask) {
            result = -result;
        }
        if (result < 0) {
            FPP.FPS |= 8; // Negative flag
        }
    }
}

function fppCompareWords(number, operand) { // Compare fraction only words giving: -ve number less, 0 equal, +ve number greater
    "use strict";
    var i, result = 0;
    for (i = 0; i < FPP.precisionLength; i++) {
        result = number[i] - operand[i];
        if (result) {
            break;
        }
    }
    return result;
}

function fppAddSmall(number, small) { // Add a small constant to fraction only words
    "use strict";
    var i, carry = small;
    for (i = FPP.precisionLength - 1; carry && i >= 0; i--) {
        carry += number[i];
        number[i] = carry & FPPwordMask;
        carry >>>= FPPwordBits;
    }
    return carry;
}

function fppIncrement(number) { // Increment a full FPP number (unpack, add 1 to fraction, repack)
    "use strict";
    var numberExp, numberSign = 0;
    numberExp = (number[0] & FPPexpMask) >>> FPPexpShift;
    if (!numberExp) {
        fppZero(number);
    } else {
        numberSign = number[0] & FPPsignMask;
        number[0] = (number[0] & FPPfractionMask) | FPPhiddenMask;
    }
    fppAddSmall(number, 1);
    if (number[0] & 0xff00) {
        numberExp++;
        fppShiftRight(number, 1);
    }
    return fppPack(number, numberExp, numberSign);
}

function fppShiftLeft(number, shift) { // Shift fraction only words left in place
    "use strict";
    var i, wordIndex, bitShift, bitField = 0;
    wordIndex = ~~(shift / FPPwordBits);
    bitShift = FPPwordBits - (shift % FPPwordBits);
    if (wordIndex < FPP.precisionLength) {
        bitField = number[wordIndex++]; // Preload bitField
    }
    for (i = 0; i < FPP.precisionLength; i++) {
        bitField <<= FPPwordBits;
        if (wordIndex < FPP.precisionLength) {
            bitField |= number[wordIndex++];
        }
        number[i] = (bitField >>> bitShift) & FPPwordMask;
    }
}

function fppShiftRight(number, shift) { // Shift fraction only words right in place returning dropped bit
    "use strict";
    var i, wordIndex, bitShift, bitField = 0,
        guardBit = 0;
    if (shift > 0) {
        wordIndex = FPP.precisionLength - ~~(shift / FPPwordBits);
        bitShift = shift % FPPwordBits;
        if (bitShift == 0) {
            if (wordIndex >= 0) {
                guardBit = number[wordIndex] >>> (FPPwordBits - 1);
            }
        } else {
            if (wordIndex > 0) {
                guardBit = number[--wordIndex] >>> (bitShift - 1);
                bitField = guardBit >>> 1;
            }
            bitShift = FPPwordBits - bitShift; // Remaining shifts are to left
        }
        for (i = FPP.precisionLength - 1; i >= 0; i--) {
            if (wordIndex > 0) {
                bitField |= number[--wordIndex] << bitShift;
            }
            number[i] = bitField & FPPwordMask;
            bitField >>>= FPPwordBits;
        }
    }
    return guardBit & 1;
}

function fppCopyShiftLeft(number, source, shift) { // Copy shifting fraction only words left
    "use strict";
    var i, wordIndex, bitShift, bitField = 0;
    wordIndex = ~~(shift / FPPwordBits);
    bitShift = FPPwordBits - (shift % FPPwordBits);
    if (wordIndex < FPP.precisionLength) {
        bitField = source[wordIndex++]; // Preload bitField
    }
    for (i = 0; i < FPP.precisionLength; i++) {
        bitField <<= FPPwordBits;
        if (wordIndex < FPP.precisionLength) {
            bitField |= source[wordIndex++];
        }
        number[i] = (bitField >>> bitShift) & FPPwordMask;
    }
}

function fppCopyRightShift(number, source, shift) { // Copy shifting fraction only words right (no overlap)
    "use strict";
    var i, wordIndex, bitField = 0;
    wordIndex = ~~(shift / FPPwordBits);
    shift = shift % FPPwordBits;
    for (i = 0; i < FPP.precisionLength; i++) {
        if (wordIndex < FPP.precisionLength) {
            bitField |= source[wordIndex++];
        }
        number[i] = (bitField >>> shift) & FPPwordMask;
        bitField <<= FPPwordBits;
    }
}

function fppCopyRightBits(number, source, shift, end) { // Copy fraction only words right (no overlap) with limit
    "use strict";
    var i, wordIndex, endShift, bitField = 0;
    wordIndex = ~~(shift / FPPwordBits);
    endShift = shift % FPPwordBits;
    end += shift;
    for (i = 0; i < FPP.precisionLength; i++) {
        if (end <= 0) {
            number[i] = 0;
        } else {
            if (wordIndex < FPP.precisionLength) {
                bitField |= source[wordIndex++];
            }
            end -= FPPwordBits;
            if (end < 0) {
                bitField &= FPPwordMask << endShift - end;
            }
            number[i] = (bitField >>> endShift) & FPPwordMask;
            bitField <<= FPPwordBits;
        }
    }
}

function fppFindNormal(number, start) { // Find where the normal point is (first bit set from a starting point)
    "use strict";
    var i, bit, word;
    bit = start % FPPwordBits;
    for (i = ~~(start / FPPwordBits); i < FPP.precisionLength; i++) {
        word = (number[i] << bit) & FPPwordMask;
        if (word) {
            while (!(word & 0x8000)) {
                word <<= 1;
                bit++;
            }
            return i * FPPwordBits + bit;
        }
        bit = 0;
    }
    return -1;
}

function fppSubtractWords(number, operand, guardBit) { // Subtract one set of fraction only words from another
    "use strict";
    var i, carry = guardBit;
    for (i = FPP.precisionLength - 1; i >= 0; i--) {
        carry = number[i] - operand[i] - carry;
        number[i] = carry & FPPwordMask;
        carry = (carry >>> FPPwordBits) & 1; // only 1 bit of carry required
    }
}

function fppAddWords(number, operand, guardBit) { // Add two sets of fraction only words
    "use strict";
    var i, carry = guardBit;
    for (i = FPP.precisionLength - 1; i >= 0; i--) {
        carry += number[i] + operand[i];
        number[i] = carry & FPPwordMask;
        carry >>>= FPPwordBits;
    }
}

function fppAdd(number, operand) { // Add two FPP numbers (number = number + operand)
    "use strict";
    var numberExp, operandExp, numberSign, operandSign, guardBit, largerNumber, normalPoint;
    numberExp = (number[0] & FPPexpMask) >>> FPPexpShift;
    operandExp = (operand[0] & FPPexpMask) >>> FPPexpShift;
    if (!operandExp) { // If operand is zero return number value
        if (!numberExp) { // If number is also zero ensure it is exact zero
            fppZero(number);
        }
        fppTest(number);
    } else {
        if (!numberExp) { // If number is zero return operand value
            fppCopy(number, operand);
            fppTest(number);
        } else { // Extract sign and exponent from operands, add the fractions, renormalize, pack...
            guardBit = 0;
            numberSign = number[0] & FPPsignMask;
            operandSign = operand[0] & FPPsignMask;
            number[0] = (number[0] & FPPfractionMask) | FPPhiddenMask;
            operand[0] = (operand[0] & FPPfractionMask) | FPPhiddenMask;
            if (!(numberSign ^ operandSign)) { // Same sign so ADD the two fractions
                if (numberExp != operandExp) { // Different magnitude - need shift to align
                    if (numberExp < operandExp) {
                        guardBit = fppShiftRight(number, operandExp - numberExp);
                        numberExp = operandExp;
                    } else {
                        guardBit = fppShiftRight(operand, numberExp - operandExp);
                    }
                    if (FPP.FPS & 0x20) {
                        guardBit = 0; // No guard bit for truncation
                    }
                }
                fppAddWords(number, operand, guardBit);
                if (number[0] & 0xff00) { // Need to normalize maximum of one bit...
                    if (!(FPP.FPS & 0x20) && (number[FPP.precisionLength - 1] & 0x1)) { // Add one if rounding and dropping a bit
                        fppAddSmall(number, 1);
                    }
                    fppShiftRight(number, 1);
                    numberExp++;
                }
            } else { // Opposite sign so SUBTRACT the two fractions
                if (numberExp == operandExp) { // Same magnitude so determine larger fraction
                    largerNumber = fppCompareWords(number, operand);
                    if (!largerNumber) { // If fractions are identical return exact zero
                        fppZero(number);
                        fppTest(number);
                        return;
                    }
                } else { // Different magntitude - need shift to align
                    if (numberExp < operandExp) {
                        guardBit = fppShiftRight(number, operandExp - numberExp);
                        numberExp = operandExp;
                        largerNumber = -1; // operand is bigger
                    } else {
                        guardBit = fppShiftRight(operand, numberExp - operandExp);
                        largerNumber = 1; // number is bigger
                    }
                    if (FPP.FPS & 0x20) {
                        guardBit = 0; // No guard bit for truncation
                    }
                }
                if (largerNumber < 0) { // If number is smaller subtract it from operand
                    fppSubtractWords(operand, number, guardBit);
                    fppCopy(number, operand);
                    numberSign = operandSign;
                } else { // If operand is smaller subtract it from number
                    fppSubtractWords(number, operand, guardBit);
                }
                if (!(number[0] & FPPhiddenMask)) {
                    normalPoint = fppFindNormal(number, 9);
                    if (normalPoint < 0) {
                        numberExp = 0;
                    } else {
                        fppShiftLeft(number, normalPoint - 8);
                        numberExp -= normalPoint - 8;
                    }
                }
            }
            fppPack(number, numberExp, numberSign);
        }
    }
}

function fppMultiply(number, operand) { // Multiply two FPP numbers (number = number x operand)
    "use strict";
    var i, j, carry, numberExp, operandExp, numberSign;
    numberExp = (number[0] & FPPexpMask) >>> FPPexpShift;
    operandExp = (operand[0] & FPPexpMask) >>> FPPexpShift;
    if (!operandExp || !numberExp) { // If either number is zero return exact zero
        fppZero(number);
        fppTest(number);
    } else { // Extract sign and exponent from operands, multiply the fractions, renormalize, pack...
        for (i = FPP.result.length - 1; i >= 0; i--) {
            FPP.result[i] = 0; // Initialize result
        }
        numberSign = (number[0] ^ operand[0]) & FPPsignMask;
        numberExp += operandExp - FPPexpBias;
        number[0] = (number[0] & FPPfractionMask) | FPPhiddenMask;
        operand[0] = (operand[0] & FPPfractionMask) | FPPhiddenMask;
        for (i = FPP.precisionLength - 1; i >= 0; i--) { // Multiply number x operand giving result
            carry = 0;
            for (j = FPP.precisionLength - 1; j >= 0; j--) {
                carry += number[i] * operand[j] + FPP.result[i + j];
                FPP.result[i + j] = carry & FPPwordMask;
                carry = (carry >>> FPPwordBits) & FPPwordMask;
            }
            if (carry) {
                FPP.result[i + j] += carry;
            }
        }
        if (!(FPP.FPS & 0x20)) { // If rounding look at bit to be dropped and round if necessary...
            if (FPP.result[0] & 0x8000) {
                if (FPP.result[FPP.precisionLength - 1] & 0x80) {
                    fppAddSmall(FPP.result, 0x100); //Round up
                }
            } else {
                if (FPP.result[FPP.precisionLength - 1] & 0x40) {
                    fppAddSmall(FPP.result, 0x80); //Round up
                }
            }
        }
        if (FPP.result[0] & 0x8000) {
            fppCopyRightShift(number, FPP.result, 8);
        } else {
            fppCopyRightShift(number, FPP.result, 7);
            numberExp--;
        }
        fppPack(number, numberExp, numberSign);
    }
}

// The division algorithm used here is adapted from the paper:
// "Multiple-Length Division Revisited: A Tour of the Minefield"   by Per Brinch Hansen
// See: https://surface.syr.edu/cgi/viewcontent.cgi?article=1162&context=eecs_techreports
//
// The significant feature of this algorithm is the proof that the qhat digit estimated
// at each step will be out by at most 1 (1 too big). Other algorithms often generate a
// slightly less accurate qhat estimate that require a greater adjustment. In this code
// we simply plough ahead using the more accurate estimated value, and if we discover
// that a carry results at the end of subtraction (of qhat x divisor), then we correct
// by adding back a copy of the divisor and subtracting 1 from qhat.

function fppDivide(number, operand) { // Divide two FPP numbers (number = number / operand)
    "use strict";
    var o, i, carry, divisor, qhat, numberExp, operandExp, numberSign;
    operandExp = (operand[0] & FPPexpMask) >>> FPPexpShift;
    if (!operandExp) { // If divide by zero then trap
        fppTrap(4); // 4 Floating divide by zero
    } else {
        numberExp = (number[0] & FPPexpMask) >>> FPPexpShift;
        if (!numberExp) { // If number is zero return exact zero
            fppZero(number);
            fppTest(number);
        } else { // Extract sign and exponent from operands, divide the fractions, renormalize, pack...
            numberSign = (number[0] ^ operand[0]) & FPPsignMask;
            numberExp -= ((operand[0] & FPPexpMask) >>> FPPexpShift) - FPPexpBias;
            number[0] = (number[0] & FPPfractionMask) | FPPhiddenMask;
            operand[0] = (operand[0] & FPPfractionMask) | FPPhiddenMask;
            for (i = FPP.result.length - 1; i >= 0; i--) {
                FPP.result[i] = 0; // Initialize result area (importantly the words beyond the current precision)
            }
            if (fppCompareWords(number, operand) < 0) { // Shift number left and ensure it is larger than operand
                fppCopyShiftLeft(FPP.result, number, 8);
            } else {
                fppCopyShiftLeft(FPP.result, number, 7);
                numberExp++;
            }
            divisor = (operand[0] * FPPwordBase + operand[1]); // Algorithm estimates qhat from 3 digits of remainder and two of divisor
            qhat = ~~((FPP.result[0] * FPPwordBase + FPP.result[1]) / divisor); // First qhat has no previous digit requirement
            for (o = 0; o < FPP.precisionLength; o++) {
                if (o) { // First time through we already have a qhat
                    qhat = ~~(((FPP.result[o - 1] * FPPwordBase + FPP.result[o]) * FPPwordBase + FPP.result[o + 1]) / divisor);
                }
                if (qhat >= FPPwordBase) qhat = FPPwordBase - 1; // Ensure qhat is in range
                carry = 0; // Multiplication carry forward & subtraction borrow
                for (i = FPP.precisionLength - 1; i >= 0; i--) { // Subtract qhat * operand from remainder
                    carry += FPP.result[o + i] - qhat * operand[i];
                    FPP.result[o + i] = carry & FPPwordMask;
                    carry = ~~((carry - FPP.result[o + i]) / FPPwordBase);
                }
                if (carry) { // Carry result from subtraction means that qhat was too big - need to adjust by one
                    if ((FPP.result[o - 1] += carry) != 0) {
                        qhat--; // Adjust qhat
                        carry = 0;
                        for (i = FPP.precisionLength - 1; i >= 0; i--) { // Add the value of operand back to the remainder
                            carry += FPP.result[o + i] + operand[i];
                            FPP.result[o + i] = carry & FPPwordMask;
                            carry = (carry >>> FPPwordBits) & FPPwordMask;
                        }
                    }
                }
                number[o] = qhat; // Store resulting digit
            }
            if (!(FPP.FPS & 0x20)) { // If rounding compute next digit...
                qhat = ~~(((FPP.result[o - 1] * FPPwordBase + FPP.result[o]) * FPPwordBase + FPP.result[o + 1]) / divisor);
                if (qhat >= FPPwordBase) qhat = FPPwordBase - 1;
                if (qhat & 0x8000) {
                    fppAddSmall(number, 1); // Round up
                }
            }
            fppPack(number, numberExp, numberSign);
        }
    }
}

function fppMODF(number, whole, operand) { // number = fraction part of number x operand - whole the optional integer part
    "use strict";
    var i, j, carry, numberExp, operandExp, numberSign, position;
    numberExp = (number[0] & FPPexpMask) >>> FPPexpShift;
    operandExp = (operand[0] & FPPexpMask) >>> FPPexpShift;
    if (!operandExp || !numberExp) { // If either number is zero return exact zero
        fppZero(number);
        fppTest(number);
        if (whole != null) {
            fppZero(whole);
        }
    } else { // Extract sign and exponent from operands, multiply the fractions, extract integer and fraction components, pack...
        for (i = FPP.result.length - 1; i >= 0; i--) {
            FPP.result[i] = 0; // Initialize result
        }
        numberSign = (number[0] ^ operand[0]) & FPPsignMask;
        numberExp += operandExp - FPPexpBias;
        number[0] = (number[0] & FPPfractionMask) | FPPhiddenMask;
        operand[0] = (operand[0] & FPPfractionMask) | FPPhiddenMask;
        for (i = FPP.precisionLength - 1; i >= 0; i--) { // Multiply number x operand giving result
            carry = 0;
            for (j = FPP.precisionLength - 1; j >= 0; j--) {
                carry += number[i] * operand[j] + FPP.result[i + j];
                FPP.result[i + j] = carry & FPPwordMask;
                carry = (carry >>> FPPwordBits) & FPPwordMask;
            }
            if (carry) {
                FPP.result[i + j] += carry;
            }
        }
        // Time for rounding!
        // Well this gets interesting. Although FPP.result is exact up to 96/32 bits we choose to use
        // only 64/32 bits. This is better than the real FP11 which appears to only calculate 59/27 bits.
        // From 64/32 bits we need to extract two 56/24 bit results which leaves 8 bits for result
        // extension and rounding, depending on the exponent value (where the decimal point lies).
        // As a result rounding will only kick in for a limited set of exponent ranges:-
        //      1) Where the exponent <= 0 there is no integer component so do normal fraction rounding
        //      2) Where the exponent < 8 then one of the extra precision bits can be used to determine rounding
        // For an exponent >= 8 we can't round because we don't use additional result bits for rounding guidance.
        if (!(FPP.FPS & 0x20)) { // FT - Truncate (not round)
            position = numberExp - FPPexpBias; // Note: numberExp has not been normalized yet so it is more "positional"
            if (position < 8) {
                if (position <= 0) {
                    position = ((FPP.result[0] & 0x8000) ? 0 : 1);
                }
                if (FPP.result[FPP.precisionLength - 1] & (0x80 >>> position)) { // Check appropriate extra bit
                    fppAddSmall(FPP.result, 0x100 >>> position); // Round up
                }
            }
        }
        // Check where result starts (normal point) - either 0 or 1 requiring a shift of 8 or 7 bits for integer component
        if (FPP.result[0] & 0x8000) {
            position = 0;
        } else {
            position = 1;
        }
        if (whole != null) { // If the optional integer component is required it comes from the start of the result
            if (numberExp - position <= FPPexpBias) {
                fppZero(whole); // No integer component if normalized exponent is too small
            } else {
                fppCopyRightBits(whole, FPP.result, 8 - position, numberExp - FPPexpBias);
                fppPack(whole, numberExp - position, numberSign);
            }
        }
        if (numberExp - position >= 0x100) { // Check for exponent overflow which results in returning the fraction as zero
            fppZero(number);
            FPP.FPS = (FPP.FPS & 0xfff0) | 4 | 2; // Zero & overflow
        } else {
            if (numberExp - position > FPPexpBias) { // If there is an integer component find the start of the fraction
                position = fppFindNormal(FPP.result, numberExp - FPPexpBias);
            }
            if (position < 0 || position >= 10 + (FPP.precisionLength - 1) * FPPwordBits) { // If no fraction or beyond limit of FP11 return zero
                fppZero(number);
                fppTest(number);
                return;
            } else { // Normalize fraction right or left as appropriate
                if (position != 8) {
                    if (position < 8) {
                        fppCopyRightShift(number, FPP.result, 8 - position);
                    } else {
                        fppCopyShiftLeft(number, FPP.result, position - 8);
                    }
                }
                numberExp -= position;
            }
            fppPack(number, numberExp, numberSign);
        }
    }
}

function fppLDCIF(number, addressMode) { // Load converting from integer to FPP
    "use strict";
    var result, src, virtualAddress, numberSign, numberExp = FPPwordBits,
        length = 2;
    result = 0;
    if (!(addressMode & 0x38)) { // If register mode use 16 bit signed resgister value
        src = CPU.registerVal[addressMode & 7] << FPPwordBits;
    } else { // Get a signed 16 or 32 bit value from memory
        if ((FPP.FPS & 0x40) && (addressMode & 0x3f) != 0x17) { // (addressMode & 077) != 027) { // FL - Long integer mode
            length = 4;
        }
        if ((result = getVirtualByMode(addressMode, MMU_READ | length)) >= 0) {
            virtualAddress = result;
            if ((result = readWordByVirtual(virtualAddress)) >= 0) {
                src = result << FPPwordBits;
                if ((FPP.FPS & 0x40) && (addressMode & 0x3f) != 0x17) { // (addressMode & 077) != 027) { // FL - Long integer mode
                    numberExp = 32;
                    virtualAddress = incrementVirtual(virtualAddress);
                    if ((result = readWordByVirtual(virtualAddress)) >= 0) {
                        src |= result;
                    }
                }
            }
        }
    }
    if (result >= 0) {
        fppZero(number);
        if (src == 0) { // If zero then done...
            fppTest(number);
        } else { // Non zero requires sign extraction and normalization
            numberSign = 0;
            if (src & 0x80000000) {
                src = 0x80000000 - (src & 0x7fffffff);
                numberSign = FPPsignMask;
            }
            if (!(src & 0xff000000)) { // Normalize smaller integer by shifting left to make a two fraction FPP number
                numberExp -= 8;
                while (!(src & 0xff800000)) {
                    src <<= 1;
                    numberExp--;
                }
                number[0] = src >>> FPPwordBits;
                number[1] = src & FPPwordMask;
            } else { // Normalze a larger integer by creating a 32 bit value from which we extract 3 fraction components
                while (!(src & 0x80000000)) {
                    src <<= 1;
                    numberExp--;
                }
                if (FPP.precisionLength == 2 && !(FPP.FPS & 0x20)) {
                    if (src & 0x80) {
                        src = (src >>> 1) + 0x80; // Shift down before rounding in case of overflow
                        if (!(src & 0x80000000)) {
                            src <<= 1;
                        }
                    }
                }
                number[0] = src >>> 24;
                number[1] = (src >>> 8) & FPPwordMask;
                number[2] = (src << 8) & FPPwordMask;
            }
            fppPack(number, numberExp + FPPexpBias, numberSign);
        }
    }
}

function fppSTCFI(number, addressMode) { // Store converting from floating to integer
    "use strict";
    var result = 0,
        words = 1,
        shift, virtualAddress, status, condition = 0;
    if ((FPP.FPS & 0x40) && (addressMode & 0x3f) != 0x17) { // (addressMode & 077) != 027) { // FL - Long integer mode
        words = 2;
    }
    shift = ((number[0] & FPPexpMask) >>> FPPexpShift) - FPPexpBias;
    if (shift <= 0) { // Zero or < 1 is easy
        result = 0;
        condition |= 4; // 8 - N,  4 - Z,  2 - V,  1 - C
    } else { // Build fraction bits into 32 bit integer and shift to get integer result
        result = (((number[0] & FPPfractionMask) | FPPhiddenMask) << 24) | (number[1] << 8);
        if (FPP.precisionLength > 2) {
            result |= number[2] >>> 8;
        }
        shift = (words * FPPwordBits) - shift;
        if (shift > 0) {
            result >>>= shift;
            if (words == 1) {
                result &= 0xffff0000;
            }
            if (number[0] & FPPsignMask) {
                result = (0x80000000 - result) | 0x80000000;
                condition |= 8; // 8 - N,  4 - Z,  2 - V,  1 - C
            }
        } else {
            if (words == 1) {
                result &= 0xffff0000;
            }
            if (shift == 0 && (number[0] & FPPsignMask) && !(result & 0xfffffff)) {
                result = 0x80000000;
                condition |= 8; // 8 - N,  4 - Z,  2 - V,  1 - C
            } else { // Overflow condition - result is zero
                result = 0;
                if (FPP.FPS & 0x100) { // FIC - Floating point conversion trap
                    fppTrap(6); // 6 Floating (or double) to integer conversion error
                }
                condition |= 4 | 1; // Z & C bits
            }
        }
    }
    if (!(addressMode & 0x38)) { // Register mode (throw away bottom 16 bits)
        CPU.registerVal[addressMode & 7] = result >>> FPPwordBits;
        FPP.FPS = (FPP.FPS & 0xfff0) | condition;
        fppFlags();
    } else {
        if ((virtualAddress = getVirtualByMode(addressMode, MMU_WRITE | (words << 1))) >= 0) {
            if ((status = writeWordByVirtual(virtualAddress, (result >>> FPPwordBits) & FPPwordMask)) >= 0) {
                if (words > 1) {
                    virtualAddress = incrementVirtual(virtualAddress);
                    status = writeWordByVirtual(virtualAddress, result & FPPwordMask);
                }
            }
            if (status >= 0) {
                FPP.FPS = (FPP.FPS & 0xfff0) | condition;
                fppFlags();
            }
        }
    }
}

function writeFloatByVirtual(virtualAddress, number) { // Write FPP number by virtual address (17 bit I&D)
    "use strict";
    var result, i;
    for (i = 0; i < FPP.modeLength; i++) { // FPP.modeLength set by prior call to getFloatVirtualByMode()
        if ((result = writeWordByVirtual(virtualAddress, number[i])) < 0) { // Write each word of the FPP number
            break;
        }
        virtualAddress = incrementVirtual(virtualAddress);
    }
    return result;
}

function readFloatByVirtual(number, virtualAddress) { // Read FPP number by virtual address (17 bit I&D)
    "use strict";
    var result, i;
    for (i = 0; i < FPP.modeLength; i++) { // FPP.modeLength set by prior call to getFloatVirtualByMode()
        if ((result = readWordByVirtual(virtualAddress)) < 0) { // Read in each word of the FPP number
            break;
        }
        number[i] = result; // Return each word of the FPP number
        virtualAddress = incrementVirtual(virtualAddress);
        //if (FPP.modeLength == 1) { // If immediate mode operand Log it
        //    FPP_OPERAND(result);
        //}
    }
    if (result >= 0) { // If all ok zero fill any remaining words
        while (i < FPP.precisionLength) {
            number[i++] = 0;
        }
    }
    // For the undefined variable (-0) trap and return a -2 so instructions can do any special handling
    if (result >= 0 && (number[0] & FPPsignMask) && !(number[0] & FPPexpMask)) { // Is it -0?
        if (FPP.FPS & 0x0800) { // Are undefined variable traps enabled?
            fppTrap(12); // 12 Floating undefined variable
            result = -2; // return -2 as special case for read undefined variable trap
        }
    }
    return result;
}

// Get Floating point number virtual address from instruction addressing mode
// Virtual addresses are used because up to 8 byte floating numbers can extend across pages
// Side effect is that FPP.modeLength is set for subsequent readFloatByVirtual and writeFloatByVirtual calls

function getFloatVirtualByMode(addressMode) { // Determine Virtual Address for instruction mode
    "use strict";
    if ((addressMode & 0x3f) == 0x17) { // (addressMode & 077) == 027 or (PC)+ as in MOV #xx,....
        FPP.modeLength = 1; // Immediate mode is always 1 word (2 bytes)!! Another perculiarity!
    } else {
        FPP.modeLength = FPP.precisionLength; // Set mode length for subsequent memory read or write operations
    }
    return getVirtualByMode(addressMode, (FPP.modeLength << 1)); // No read/write flags - just autoincrement length
}

function writeFloatByMode(addressMode, number) { // Write FPP number by instruction mode
    "use strict";
    var result;
    if (!(addressMode & 0x38)) { // If register mode write to register
        addressMode &= 7; // Now just register number
        if (addressMode < 6) {
            fppCopy(FPP.AC[addressMode], number);
            result = 0;
        } else {
            result = fppTrap(2); // Illegal register
        }
    } else {
        if ((result = getFloatVirtualByMode(addressMode)) >= 0) { // (mode sets FPP.modeLength)
            result = writeFloatByVirtual(result, number); // Write to memory (uses FPP.modeLength)
        }
    }
    return result;
}

function readFloatByMode(number, addressMode) { // Read FPP number by instruction mode
    "use strict";
    var virtualAddress, result;
    if (!(addressMode & 0x38)) { // If register mode copy from register
        addressMode &= 7; // Now just register number
        if (addressMode < 6) {
            fppCopy(number, FPP.AC[addressMode]);
            CPU.modifyRegister = addressMode; // Remember register number in case of modify
            result = 0;
        } else {
            result = fppTrap(2); // Illegal register
        }
    } else {
        if ((virtualAddress = getFloatVirtualByMode(addressMode)) < 0) { // (mode sets FPP.modeLength)
            return virtualAddress;
        }
        result = readFloatByVirtual(number, virtualAddress); // Read from memory (uses FPP.modeLength)
        CPU.modifyRegister = -1;
        CPU.modifyAddress = virtualAddress; // Remember virtual address in case of modify
    }
    return result;
}

function modifyFloat(number) { // Update last FPP number read
    "use strict";
    if (CPU.modifyRegister >= 0) {
        fppCopy(FPP.AC[CPU.modifyRegister], number); // Write back to register
    } else {
        return writeFloatByVirtual(CPU.modifyAddress, number); // Write back to memory (uses FPP.modeLength)
    }
    return 0;
}

function executeFPP(instruction) { // Main entry point call by mainline emulation when a FPP instruction is encountered
    "use strict";
    var AC,
        result,
        virtualAddress;
    //var mmrUnwind = 0;  // DEBUG code to help validate CPU.MMR1 works correctly
    //if (!(CPU.MMR0 & 0xe000)) {
    //    mmrUnwind = 1;
    //}
    FPP.backupPC = CPU.registerVal[7];
    AC = (instruction >>> 6) & 3;
    switch ((instruction >>> 8) & 0xf) { // 007400 FPP OP code
        case 0: // 170000 Miscellaneous group 0 FPP instructions
            switch (AC) { // For this group the AC field decides the operation
                case 0: // 00 Group 0 further subdivided
                    switch (instruction & 0x3f) {
                        case 0: // 170000 CFCC Copy Floating Condition Codes
                            //FPP_INSTRUCTION(instruction, "cfcc", 0);
                            fppFlags();
                            break;
                        case 1: // 170001 SETF Set Floating Mode
                            //FPP_INSTRUCTION(instruction, "setf", 0);
                            FPP.FPS &= 0xff7f;
                            FPP.precisionLength = 2; // Floating is two word precision
                            break;
                        case 2: // 170002 SETI Set Integer Mode
                            //FPP_INSTRUCTION(instruction, "seti", 0);
                            FPP.FPS &= 0xffbf;
                            break;
                            //case 3: // 170003 LDUP - not valid on all systems
                            //    //FPP_INSTRUCTION(instruction, "ldup", 0);
                            //    break;
                        case 9: // 170011 SETD Set Floating Double Mode
                            //FPP_INSTRUCTION(instruction, "setd", 0);
                            FPP.FPS |= 0x80;
                            FPP.precisionLength = 4; // Double is four word precision
                            break;
                        case 10: // 170012 SETL Set Long Integer Mode
                            //FPP_INSTRUCTION(instruction, "setl", 0);
                            FPP.FPS |= 0x40;
                            break;
                        default: // We don't know this instruction
                            //FPP_INSTRUCTION(instruction, "-unknown-", 0);
                            fppTrap(2); // Unknown FPP opcode
                            break;
                    }
                    break;
                case 1: // 1701SS Load FPP Program Status
                    //FPP_INSTRUCTION(instruction, "ldfps", 1);
                    if ((result = readWordByMode(instruction)) >= 0) {
                        FPP.FPS = result & 0xcfff;
                        if (!(FPP.FPS & 0x80)) { // FD - Double precision mode
                            FPP.precisionLength = 2; // Floating is two word precision
                        } else {
                            FPP.precisionLength = 4; // Double is four word precision
                        }
                    }
                    break;
                case 2: // 1702DD Store FPP Program Status
                    //FPP_INSTRUCTION(instruction, "stfps", 1);
                    writeWordByMode(instruction, FPP.FPS);
                    break;
                case 3: // 1703DD  STST Store FEC and FEA
                    //FPP_INSTRUCTION(instruction, "stst", 1);
                    if (!(instruction & 0x38)) { // FEC only for general register
                        CPU.registerVal[instruction & 7] = FPP.FEC;
                    } else {
                        if ((virtualAddress = getVirtualByMode(instruction, MMU_WRITE | 4)) >= 0) {
                            if (writeWordByVirtual(virtualAddress, FPP.FEC) >= 0) {
                                virtualAddress = incrementVirtual(virtualAddress);
                                writeWordByVirtual(virtualAddress, FPP.FEA);
                            }
                        }
                    }
                    break;
            }
            break;
        case 0x1: // 1704xx Single operand FPP instructions
            switch (AC) { // For this group the AC field decides the operation
                case 0: // 1704FF CLRF Clear Floating/Double
                    //FPP_INSTRUCTION(instruction, "clrf", 1);
                    fppZero(FPP.scratch);
                    if (writeFloatByMode(instruction, FPP.scratch) >= 0) {
                        fppTest(FPP.scratch);
                    }
                    break;
                case 1: // 1705FF TSTF Test Floating/Double
                    //FPP_INSTRUCTION(instruction, "tstf", 1);
                    if (readFloatByMode(FPP.scratch, instruction) != -1) {
                        fppTest(FPP.scratch);
                    }
                    break;
                case 2: // 1706FF ABSF Make Absolute Floating/Double
                    //FPP_INSTRUCTION(instruction, "absf", 1);
                    if (readFloatByMode(FPP.scratch, instruction) != -1) { // Allow for undefined variable trap (-2)
                        if (!(FPP.scratch[0] & FPPexpMask)) {
                            fppZero(FPP.scratch);
                        } else {
                            FPP.scratch[0] &= ~FPPsignMask;
                        }
                        if (modifyFloat(FPP.scratch) >= 0) {
                            fppTest(FPP.scratch);
                        }
                    }
                    break;
                case 3: // 1707FF NEGF Negate Floating/Double
                    //FPP_INSTRUCTION(instruction, "negf", 1);
                    if (readFloatByMode(FPP.scratch, instruction) != -1) { // Allow for undefined variable trap (-2)
                        if (!(FPP.scratch[0] & FPPexpMask)) {
                            fppZero(FPP.scratch);
                        } else {
                            FPP.scratch[0] ^= FPPsignMask;
                        }
                        if (modifyFloat(FPP.scratch) >= 0) {
                            fppTest(FPP.scratch);
                        }
                    }
                    break;
            }
            break;
        case 0x2: // 1710AFF MULF Multiply Floating/Double
            //FPP_INSTRUCTION(instruction, "mulf", 7);
            if (readFloatByMode(FPP.scratch, instruction) >= 0) {
                fppMultiply(FPP.AC[AC], FPP.scratch);
            }
            break;
        case 0x3: // 1714AFF MODF Multiply and integerize Floating/Double
            //FPP_INSTRUCTION(instruction, "modf", 7);
            if (readFloatByMode(FPP.scratch, instruction) >= 0) {
                if (AC & 1) { // Special case for odd AC where integer result is not returned (we have nowhere to put it)
                    fppMODF(FPP.AC[AC], null, FPP.scratch);
                } else {
                    fppMODF(FPP.AC[AC], FPP.AC[AC + 1], FPP.scratch);
                }
            }
            break;
        case 0x4: // 1720AFF ADDF Add Floating/Double
            //FPP_INSTRUCTION(instruction, "addf", 7);
            if (readFloatByMode(FPP.scratch, instruction) >= 0) {
                fppAdd(FPP.AC[AC], FPP.scratch);
            }
            break;
        case 0x5: // 1724AFF LDF Load Floating/Double
            //FPP_INSTRUCTION(instruction, "ldf", 7);
            if (readFloatByMode(FPP.AC[AC], instruction) >= 0) {
                fppTest(FPP.AC[AC]);
            }
            break;
        case 0x6: // 1730AFF SUBF Subtract Floating/Double
            //FPP_INSTRUCTION(instruction, "subf", 7);
            if (readFloatByMode(FPP.scratch, instruction) >= 0) {
                FPP.scratch[0] ^= FPPsignMask; // For subtraction change sign of operand and add
                fppAdd(FPP.AC[AC], FPP.scratch);
            }
            break;
        case 0x7: // 1734AFF CMPF Compare Floating/Double
            //FPP_INSTRUCTION(instruction, "cmpf", 7);
            if (readFloatByMode(FPP.scratch, instruction) >= 0) {
                fppCompare(FPP.scratch, FPP.AC[AC]);
            }
            break;
        case 0x8: // 1740AFF STF Store Floating/Double
            //FPP_INSTRUCTION(instruction, "stf", 7);
            writeFloatByMode(instruction, FPP.AC[AC]);
            break;
        case 0x9: // 1744AFF DIVF Divide Floating/Double
            //FPP_INSTRUCTION(instruction, "divf", 7);
            if (readFloatByMode(FPP.scratch, instruction) >= 0) {
                fppDivide(FPP.AC[AC], FPP.scratch);
            }
            break;
        case 0xa: // 1750ADD STEXP Store Exponent
            //FPP_INSTRUCTION(instruction, "stexp", 7);
            result = ((FPP.AC[AC][0] & FPPexpMask) >>> FPPexpShift) - FPPexpBias;
            if (writeWordByMode(instruction, result) >= 0) {
                fppTestInt(result);
                fppFlags();
            }
            break;
        case 0xb: // 1754ADD STCFI Convert Floating/Double to Integer/Long Integer
            //FPP_INSTRUCTION(instruction, "stcfi", 7);
            fppSTCFI(FPP.AC[AC], instruction);
            break;
        case 0xc: // 176AFF STCFD Store converting Floating/Double to Double Floating
            //FPP_INSTRUCTION(instruction, "stcff", 7); // F to D if FD == 0
            result = 1; // Flag to test condition codes
            fppCopy(FPP.scratch, FPP.AC[AC]); //Copy operand as we may modify by rounding
            FPP.precisionLength = 6 - FPP.precisionLength; // Reverse current precision before rounding or writing
            if (FPP.precisionLength == 4) { // Writing double so it needs to be zero extended from real
                FPP.scratch[2] = FPP.scratch[3] = 0;
            } else { // Double to Real may require rounding
                if (!(FPP.FPS & 0x20) && (FPP.scratch[2] & 0x8000)) { // not FT - Truncate and dropping significant bit
                    fppIncrement(FPP.scratch); // sets flags etc - probably should only set overflow AFTER write attempt
                    result = 0; // Need to preserve condition codes after increment (could have overflowed?)
                }
            }
            if ((writeFloatByMode(instruction, FPP.scratch) >= 0) && result) {
                fppTest(FPP.scratch); // It would be better if we could test and preserve overflow
            }
            FPP.precisionLength = 6 - FPP.precisionLength; // Restore precision
            break;
        case 0xd: // 1764ASS LDEXP Load Exponent
            //FPP_INSTRUCTION(instruction, "ldexp", 7);
            if ((result = readWordByMode(instruction)) >= 0) {
                fppLDEXP(FPP.AC[AC], result);
            }
            break;
        case 0xe: // 1770ASS LDCIF Convert Integer/Long Integer to Floating/Double
            //FPP_INSTRUCTION(instruction, "ldcif", 7);
            fppLDCIF(FPP.AC[AC], instruction);
            break;
        case 0xf: // 1774AFF LDCDF Load converting Floating/Double to Double Floating
            //FPP_INSTRUCTION(instruction, "ldcdf", 7);
            FPP.precisionLength = 6 - FPP.precisionLength; // Reverse current precision before reading value
            if (readFloatByMode(FPP.AC[AC], instruction) >= 0) {
                FPP.precisionLength = 6 - FPP.precisionLength; // Restore precision
                if (FPP.precisionLength == 4) { // In double mode zero fill from real
                    FPP.AC[AC][2] = FPP.AC[AC][3] = 0;
                    fppTest(FPP.AC[AC]);
                } else { // In real mode truncate from double with rounding if needed
                    if (!(FPP.FPS & 0x20) && (FPP.AC[AC][2] & 0x8000)) { // FT - Truncate
                        fppIncrement(FPP.AC[AC]); // sets flags etc - have to figure out how to set overflow AFTER write attempt}
                    } else {
                        fppTest(FPP.AC[AC]);
                    }
                    FPP.AC[AC][2] = FPP.AC[AC][3] = 0;
                }

            } else {
                FPP.precisionLength = 6 - FPP.precisionLength; // Restore precision if error
            }
            break;
        default: // We don't know this instruction
            //FPP_INSTRUCTION(instruction, "-unknown-", 0);
            fppTrap(2); // Unknown FPP opcode
            break;
    }
    //if ((CPU.MMR0 & 0xe000) && mmrUnwind) {
    //    if ((CPU.MMR1 & 0xf8) && (CPU.MMR1 & 7) != 7) {
    //        if (CPU.MMR1 & 0x80) {
    //            CPU.registerVal[CPU.MMR1 & 7] += (0x80 - (CPU.MMR1 & 0x78)) >>> 3;
    //        } else {
    //            CPU.registerVal[CPU.MMR1 & 7] -= ((CPU.MMR1 & 0x78) >>> 3);
    //        }
    //    }
    //    CPU.MMR1 = 0;
    //}
}