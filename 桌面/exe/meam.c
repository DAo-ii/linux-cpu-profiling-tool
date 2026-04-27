#include <stdio.h> 
#include <stdlib.h> 
#include <unistd.h> 

int main(int argc, char* argv[]) { 
    int *p = (int *)malloc(sizeof(int)); 
    if (p == NULL) { 
        perror("Failed to allocate memory"); 
        return EXIT_FAILURE; 
    } 

    printf("(%d) memory address of p: %p\n", getpid(), (void *)p); 
    *p = 0; 

    // 无限循环，直到手动中断 
    while (1) { 
        sleep(1); 
        *p = *p + 1; 
        printf("(%d) p: %d\n", getpid(), *p); 
    } 

    // 释放内存（虽然代码不会到这里，但增加这个是个好习惯） 
    free(p); 
    return 0; 
}

