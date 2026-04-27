#include <stdio.h> 
#include <fcntl.h> 
#include <sys/types.h> 
#include <unistd.h> // 包含 close() 函数的头文件 
#include <stdlib.h> // 包含 exit() 函数的头文件 
#include <string.h> // 包含 strlen() 函数的头文件 

int main(int argc, char* argv[]) { 
    // 打开或创建文件 
    int fd = open("/tmp/file", O_WRONLY | O_CREAT | O_TRUNC, S_IRWXU); 
    if (fd == -1) { // 检查文件打开是否成功 
        perror("Error opening file"); 
        exit(EXIT_FAILURE); 
    } 

    const char *message = "hello world\n"; 
    // 写入内容 
    ssize_t rc = write(fd, message, strlen(message)); 
    if (rc == -1) { // 检查写入是否成功 
        perror("Error writing to file"); 
        close(fd); 
        exit(EXIT_FAILURE); 
    } 

    // 关闭文件 
    if (close(fd) == -1) { // 检查关闭是否成功 
        perror("Error closing file"); 
        exit(EXIT_FAILURE); 
    } 

    return 0; 
}
