# The gessologic ISA

The instruction set of the 8-bit CPU that Part three builds from gates.
Frozen in Phase 13: the reference emulator (`src/cpu/Emulator.ts`)
implements it, the assembler (`src/cpu/Assembler.ts`) encodes it, and
the gate-level CPU is held to the emulator in lockstep (Phase 18). The
opcode table below is checked against `src/cpu/Isa.ts` by
`src/cpu/Isa.spec.ts`, so the two cannot drift.

## The machine

**Harvard, 8-bit.** Programs live in a 256 × 16-bit ROM. Data lives in
a separate 8-bit address space. Nothing writes the ROM.

| Register | Width | What |
| -------- | ----: | ---- |
| A        | 8 | the accumulator: ALU results, loads, I/O |
| B        | 8 | the ALU's second operand |
| X        | 8 | the index register |
| PC       | 8 | the next instruction's ROM address |
| IR       | 16 | the instruction being executed |
| L        | 8 | the link register: where `RET` returns to |
| Z, C, N  | 1 each | zero, carry, negative |

**Reset** clears every register, every flag and every byte of RAM, and
starts at ROM address 0. After a reset, nothing in RAM has to be
initialised.

## Memory and ports

| Data address | What |
| ------------ | ---- |
| `0x00–0x3F`  | 64 bytes of general RAM |
| `0x40–0x7F`  | 64 bytes of framebuffer: 32 × 16 pixels, one bit each, and ordinary RAM to the CPU |
| `0x80–0xFF`  | nothing: reads 0, writes are ignored |

| Port | In | Out |
| ---- | -- | --- |
| 0 | the buttons | the left score display |
| 1 | the frame tick | the right score display |
| 2 | nothing (reads 0) | nothing |
| 3 | nothing (reads 0) | nothing: the test suite logs its checkpoints here |

A port number is 0–3; the assembler refuses anything else.

## Instructions

An instruction is one ROM word: **the opcode in the high byte, the
operand `k` in the low byte.** Every instruction takes **two clock
cycles**:

1. **Fetch:** IR ← ROM[PC], then PC ← PC + 1.
2. **Execute:** the effect below.

So a `CALL` saves the address of the instruction after it, and a taken
branch simply overwrites the PC that the fetch advanced.

The operand forms, and how the assembler writes each:

| Form | Written | The value used |
| ---- | ------- | -------------- |
| immediate | `#k` | k itself |
| absolute | `a` | M[a], the data byte at address a |
| indexed | `a,X` | M[(a + X) mod 256] |
| register | `B` | B; the operand byte is unused |
| target | `t` | a ROM address |
| port | `p` | a port, 0–3 |
| table | `t,X` | the low byte of ROM[(t + X) mod 256] |

**Flags** are set only by the ALU, shift and `INX`/`DEX` instructions
marked below, and left alone by everything else: loads, stores,
transfers, I/O and jumps never touch them. Where a flag is set:

- Z ← the result is 0;
- N ← bit 7 of the result;
- C ← carry out of an `ADD`; for `SUB` and `CMP`, 1 when there was no
  borrow (A ≥ v, as a 6502 does it); for a shift, the bit shifted out.

`ADD` has no carry in, and there is no `ADC`. The logic operations
leave C alone, and so do `INX` and `DEX`, which set Z and N from X.

`*` sets the flag, and `-` leaves it alone.

| Opcode | Instruction | Z C N | Effect |
| ------ | ----------- | ----- | ------ |
| `00` | `HLT` | - - - | stop; PC is left past the HLT |
| `01` | `NOP` | - - - | nothing |
| `10` | `LDA #k` | - - - | A ← k |
| `11` | `LDA a` | - - - | A ← M[a] |
| `12` | `LDA a,X` | - - - | A ← M[a + X] |
| `14` | `LDB #k` | - - - | B ← k |
| `15` | `LDB a` | - - - | B ← M[a] |
| `18` | `LDX #k` | - - - | X ← k |
| `19` | `LDX a` | - - - | X ← M[a] |
| `1C` | `LDT t,X` | - - - | A ← low byte of ROM[t + X] |
| `20` | `STA a` | - - - | M[a] ← A |
| `21` | `STA a,X` | - - - | M[a + X] ← A |
| `28` | `TAX` | - - - | X ← A |
| `29` | `TXA` | - - - | A ← X |
| `2A` | `TAB` | - - - | B ← A |
| `2B` | `TBA` | - - - | A ← B |
| `30` | `ADD #k` | * * * | A ← A + k; C ← carry out |
| `31` | `SUB #k` | * * * | A ← A − k; C ← 1 when no borrow (A ≥ k) |
| `32` | `AND #k` | * - * | A ← A ∧ k |
| `33` | `OR #k` | * - * | A ← A ∨ k |
| `34` | `XOR #k` | * - * | A ← A ⊕ k |
| `35` | `CMP #k` | * * * | A − k, flags only; C ← 1 when A ≥ k |
| `40` | `ADD B` | * * * | A ← A + B; C ← carry out |
| `41` | `SUB B` | * * * | A ← A − B; C ← 1 when no borrow (A ≥ B) |
| `42` | `AND B` | * - * | A ← A ∧ B |
| `43` | `OR B` | * - * | A ← A ∨ B |
| `44` | `XOR B` | * - * | A ← A ⊕ B |
| `45` | `CMP B` | * * * | A − B, flags only; C ← 1 when A ≥ B |
| `50` | `ADD a` | * * * | A ← A + M[a]; C ← carry out |
| `51` | `SUB a` | * * * | A ← A − M[a]; C ← 1 when no borrow (A ≥ M[a]) |
| `52` | `AND a` | * - * | A ← A ∧ M[a] |
| `53` | `OR a` | * - * | A ← A ∨ M[a] |
| `54` | `XOR a` | * - * | A ← A ⊕ M[a] |
| `55` | `CMP a` | * * * | A − M[a], flags only; C ← 1 when A ≥ M[a] |
| `60` | `SHL` | * * * | C ← A bit 7; A ← A << 1 |
| `61` | `SHR` | * * * | C ← A bit 0; A ← A >> 1, a 0 shifted in |
| `62` | `INX` | * - * | X ← X + 1 |
| `63` | `DEX` | * - * | X ← X − 1 |
| `70` | `JMP t` | - - - | PC ← t |
| `71` | `JZ t` | - - - | PC ← t if Z |
| `72` | `JNZ t` | - - - | PC ← t if not Z |
| `73` | `JC t` | - - - | PC ← t if C |
| `74` | `JNC t` | - - - | PC ← t if not C |
| `75` | `JN t` | - - - | PC ← t if N |
| `76` | `JNN t` | - - - | PC ← t if not N |
| `78` | `CALL t` | - - - | L ← PC; PC ← t |
| `79` | `RET` | - - - | PC ← L |
| `80` | `IN p` | - - - | A ← port p |
| `81` | `OUT p` | - - - | port p ← A |

Every opcode not in the table is reserved. The emulator stops with an
error on one, and a program must not use one: the gate-level control
unit does whatever its decode happens to do. Opcode `00` is `HLT`, so an
empty ROM word, and running off the end of a program, halts.

## Notes for the hardware

- **Two cycles for everything** keeps the control unit to one row per
  opcode for execute, plus one shared fetch row. The data address for
  `a,X` comes from a dedicated 8-bit adder (operand + X), the library's
  48-gate `add/sub 8`: cheaper than a memory-address register and a
  third cycle.
- **`LDT` reads the ROM through a second port.** The ROM is a lookup
  primitive, not gates (see the showpiece's counting rules), so a second
  address port costs nothing. `.byte` data can then be read, which a
  Harvard machine otherwise can't do.
- **One level of `CALL`.** `L` is a register, not a stack. A `CALL`
  inside a subroutine overwrites it, and the outer subroutine's `RET`
  then returns to the inner call's return address. `callret.asm` tests
  exactly that.
- **`HLT`** stops the clock's effect on the CPU. PC is left pointing
  past the `HLT`.
- **The PC wraps** from `0xFF` to `0x00`.

## The assembler

```
; a comment runs to the end of the line
BALL = 0x10             ; a constant: a name for a value
start:  LDA #1          ; a label, and an instruction
        STA BALL        ; absolute
        LDA 0x40,X      ; indexed
        ADD B           ; register B
        LDT masks,X     ; a byte from a table in the ROM
        OUT 0           ; a port
        JMP start       ; a target
masks:  .byte 1, 2, 4, 8, 0x10, 0x20, 0x40, 0x80
        .org 0xF0       ; carry on at a later ROM address
```

- Mnemonics and `B` and `X` are case-blind; names are not. `A`, `B` and
  `X` can't be names.
- A value is a sum or difference of numbers (`12`, `0x0C`, `0b1100`,
  `'c'`) and names. It must fit a byte, and a negative value is taken as
  its two's complement.
- A constant may use names defined anywhere in the file; `.org` only
  names defined above it.
- `.byte` puts one value in each ROM word's low byte, for `LDT` to read.
- Every error is reported with its line number, all of them, before
  anything is thrown.
