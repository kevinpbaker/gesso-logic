; Every branch, taken and not taken. Each logs 1 where it went the way
; it should and falls into `wrong` otherwise, which logs 0xEE and halts.
;! log=1,1,1,1,1,1,1,1,1,1,1,0x42
;! A=0x42

        JMP start
        JMP wrong
start:  LDA #1
        OUT 3           ; JMP taken

        CMP #1          ; Z C, not N
        JZ t1
        JMP wrong
t1:     OUT 3
        JNZ wrong       ; not taken
        OUT 3
        JC t2
        JMP wrong
t2:     OUT 3
        JNC wrong
        OUT 3
        JN wrong
        OUT 3
        JNN t3
        JMP wrong
t3:     OUT 3

        CMP #2          ; 1 − 2: N, not Z, not C
        JZ wrong
        JNZ t4
        JMP wrong
t4:     OUT 3
        JC wrong
        JNC t5
        JMP wrong
t5:     OUT 3
        JNN wrong
        JN t6
        JMP wrong
t6:     OUT 3

        ; A backward branch: a loop counting X down from 5.
        LDX #5
        LDA #0
loop:   ADD #1
        DEX
        JNZ loop
        CMP #5
        JNZ wrong
        LDA #1
        OUT 3

        ; Branching to the last word of the ROM, and PC wrapping to 0 is
        ; not tested here: a program can't come back from it.
        LDA #0x42
        OUT 3
        HLT

wrong:  LDA #0xEE
        OUT 3
        HLT
