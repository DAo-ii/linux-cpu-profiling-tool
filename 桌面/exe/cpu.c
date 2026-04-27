#include <stdio.h> 
#include <stdlib.h> 

int main(int argc, char *argv[]) { 
    // 检查参数个数 
    if (argc != 2) { 
        fprintf(stderr, "Usage: %s <string>\n", argv[0]); // 打印正确的使用提示 
        exit(1); 
    } 

    char *str = argv[1]; // 获取命令行参数 

    // 循环打印 
    for (int i = 0; i < 10; i++) { 
        printf("%s\n", str); 
    } 

    return 0; // 返回成功状态 
}
