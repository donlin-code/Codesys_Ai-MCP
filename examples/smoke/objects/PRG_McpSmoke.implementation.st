GVL_McpSmoke.stEcho := GVL_McpSmoke.stCommand;
IF GVL_McpSmoke.diScanCount >= 2147483640 THEN
    GVL_McpSmoke.diScanCount := 0;
ELSE
    GVL_McpSmoke.diScanCount := GVL_McpSmoke.diScanCount + C_INCREMENT;
END_IF
